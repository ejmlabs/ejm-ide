use ejm_ide_lib::{
    language::{server_command, server_initialization_options},
    lsp::{Language, LspClient, byte_offset_to_position, path_to_uri},
};
use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    thread,
    time::{Duration, Instant},
};

fn request_until(
    client: &LspClient,
    method: &str,
    params: Value,
    populated: impl Fn(&Value) -> bool,
) -> Value {
    let started = Instant::now();
    let mut last = String::new();
    while started.elapsed() < Duration::from_secs(35) {
        match client.handle().request_blocking(method, params.clone()) {
            Ok(value) if populated(&value) => return value,
            Ok(value) => last = value.to_string(),
            Err(error) => last = error.to_string(),
        }
        thread::sleep(Duration::from_millis(200));
    }
    panic!(
        "{method} never returned the expected result: {last}. {}",
        client.stderr_tail()
    );
}

fn verify(language: Language, relative: &str, symbol: &str, caller: &str) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../examples/harbor")
        .canonicalize()
        .unwrap();
    let path = root.join(relative);
    let text = fs::read_to_string(&path).unwrap();
    let command = server_command(language, None).unwrap();
    let mut client = LspClient::start_with_options(
        &root,
        language,
        command,
        server_initialization_options(language, None),
    )
    .unwrap();
    println!(
        "{} capabilities: {}",
        language.name(),
        client.capabilities()
    );
    assert!(supports(&client, "hoverProvider"));
    client.open(&path, &text).unwrap();
    let call_offset = text.rfind(symbol).unwrap();
    let position = byte_offset_to_position(&text, call_offset + 1);
    let params =
        json!({ "textDocument": { "uri": path_to_uri(&path).unwrap() }, "position": position });
    let hover = request_until(&client, "textDocument/hover", params.clone(), |value| {
        !value.is_null()
    });
    assert!(hover.to_string().contains(symbol), "{hover}");
    if language == Language::TypeScript {
        let outline = request_until(
            &client,
            "textDocument/documentSymbol",
            json!({ "textDocument": params["textDocument"] }),
            |value| value.as_array().is_some_and(|items| !items.is_empty()),
        );
        let declaration = outline
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["name"] == symbol)
            .expect("The outline must include the function declaration");
        let identifier = &declaration["selectionRange"]["start"];
        assert!(
            identifier.is_object(),
            "The outline must provide the identifier location for body-following: {declaration}"
        );
        let hierarchy = request_until(
            &client,
            "textDocument/prepareCallHierarchy",
            json!({ "textDocument": params["textDocument"], "position": identifier }),
            |value| value.as_array().is_some_and(|items| !items.is_empty()),
        );
        assert_eq!(hierarchy[0]["name"], symbol);
        println!("TypeScript: call hierarchy follows the outline identifier");
    }
    if client.capabilities()["semanticTokensProvider"]["full"] != Value::Null
        && client.capabilities()["semanticTokensProvider"]["full"] != false
    {
        let tokens = request_until(
            &client,
            "textDocument/semanticTokens/full",
            json!({ "textDocument": params["textDocument"] }),
            |value| {
                value["data"]
                    .as_array()
                    .is_some_and(|data| !data.is_empty())
            },
        );
        let data = tokens["data"].as_array().unwrap();
        let legend = client.capabilities()["semanticTokensProvider"]["legend"]["tokenTypes"]
            .as_array()
            .unwrap();
        let (data, remainder) = data.as_chunks::<5>();
        assert!(remainder.is_empty(), "Incomplete semantic token tuple");
        assert!(
            data.iter()
                .all(|token| token[3].as_u64().unwrap() < legend.len() as u64)
        );
        assert!(
            language == Language::Ruby
                || data.iter().any(|token| matches!(
                    legend[token[3].as_u64().unwrap() as usize].as_str(),
                    Some("function" | "method")
                )),
            "Missing semantic function tokens: {tokens}"
        );
        println!("{}: semantic tokens passed", language.name());
    }
    if supports(&client, "callHierarchyProvider") {
        verify_call_hierarchy(&client, params.clone(), symbol, caller);
    } else {
        assert_eq!(language, Language::Ruby);
        println!("Ruby LSP does not advertise semantic callers or callees.");
    }
    if matches!(language, Language::Ruby | Language::Go) {
        assert!(supports(&client, "completionProvider"));
        let completion = request_until(
            &client,
            "textDocument/completion",
            json!({ "textDocument": params["textDocument"], "position": byte_offset_to_position(&text, call_offset + 3) }),
            |value| value.to_string().contains(symbol),
        );
        assert!(completion.to_string().contains(symbol));
        assert!(supports(&client, "signatureHelpProvider"));
        let signature = request_until(
            &client,
            "textDocument/signatureHelp",
            json!({ "textDocument": params["textDocument"], "position": byte_offset_to_position(&text, call_offset + symbol.len() + 1) }),
            |value| {
                value["signatures"]
                    .as_array()
                    .is_some_and(|items| !items.is_empty())
            },
        );
        assert!(signature.to_string().contains(symbol));
    }
    let minimum_references = if language == Language::Ruby { 1 } else { 2 };
    let references = request_until(
        &client,
        "textDocument/references",
        json!({
            "textDocument": params["textDocument"], "position": position,
            "context": { "includeDeclaration": true }
        }),
        |value| {
            value
                .as_array()
                .is_some_and(|items| items.len() >= minimum_references)
        },
    );
    assert!(references.as_array().unwrap().len() >= minimum_references);
    let definition = request_until(&client, "textDocument/definition", params, |value| {
        !value.is_null() && value.as_array().is_none_or(|items| !items.is_empty())
    });
    assert!(
        definition
            .to_string()
            .contains(path.file_name().unwrap().to_str().unwrap())
    );
    client.save_version(&path, &text, 1).unwrap();
    if matches!(language, Language::Ruby | Language::Go) {
        let changed_symbol = format!("{symbol}_updated");
        let changed = text.replace(symbol, &changed_symbol);
        client.change_version(&path, &changed, 2).unwrap();
        let hover = request_until(
            &client,
            "textDocument/hover",
            json!({
                "textDocument": { "uri": path_to_uri(&path).unwrap() },
                "position": byte_offset_to_position(&changed, changed.rfind(&changed_symbol).unwrap() + 1)
            }),
            |value| value.to_string().contains(&changed_symbol),
        );
        assert!(hover.to_string().contains(&changed_symbol));
        if language == Language::Ruby {
            let bulk_symbol = format!("{symbol}_bulk_updated");
            let bulk = format!(
                "# Updated in the unsaved buffer.\n{}",
                changed.replace(&changed_symbol, &bulk_symbol)
            );
            client.change_version(&path, &bulk, 3).unwrap();
            request_until(
                &client,
                "textDocument/hover",
                json!({
                    "textDocument": { "uri": path_to_uri(&path).unwrap() },
                    "position": byte_offset_to_position(&bulk, bulk.rfind(&bulk_symbol).unwrap() + 1)
                }),
                |value| value.to_string().contains(&bulk_symbol),
            );
            println!("Ruby: unsaved bulk comment and declaration changes passed");
        }
        println!("{}: unsaved document changes passed", language.name());
    }
    println!(
        "{}: hover, definition and references passed",
        language.name()
    );
}

fn supports(client: &LspClient, capability: &str) -> bool {
    let value = &client.capabilities()[capability];
    !value.is_null() && value != false
}

fn verify_call_hierarchy(client: &LspClient, params: Value, symbol: &str, caller: &str) {
    let hierarchy = request_until(
        client,
        "textDocument/prepareCallHierarchy",
        params.clone(),
        |value| value.as_array().is_some_and(|items| !items.is_empty()),
    );
    let item = hierarchy[0].clone();
    let incoming = request_until(
        client,
        "callHierarchy/incomingCalls",
        json!({ "item": item }),
        |value| value.as_array().is_some_and(|items| !items.is_empty()),
    );
    assert!(incoming.to_string().contains(caller), "{incoming}");
    let caller_item = incoming
        .as_array()
        .unwrap()
        .iter()
        .find(|call| {
            call["from"]["name"]
                .as_str()
                .is_some_and(|name| name.contains(caller))
        })
        .unwrap()["from"]
        .clone();
    let outgoing = request_until(
        client,
        "callHierarchy/outgoingCalls",
        json!({ "item": caller_item }),
        |value| value.as_array().is_some_and(|items| !items.is_empty()),
    );
    assert!(outgoing.to_string().contains(symbol), "{outgoing}");
    println!("Semantic callers and callees passed");
}

#[test]
#[ignore = "requires installed rust-analyzer and the local sample workspace"]
fn rust_language_server() {
    verify(
        Language::Rust,
        "src/money.rs",
        "calculate_total",
        "settle_order",
    );
}

#[test]
#[ignore = "requires Node.js and the local pyright package"]
fn python_language_server() {
    verify(
        Language::Python,
        "tools/reconcile.py",
        "total_received",
        "reconcile",
    );
}

#[test]
#[ignore = "requires Node.js and the local TypeScript language server packages"]
fn typescript_language_server() {
    verify(
        Language::TypeScript,
        "web/orders.ts",
        "calculateTotal",
        "orderSummary",
    );
}

#[test]
#[ignore = "requires installed Ruby LSP"]
fn ruby_language_server() {
    verify(
        Language::Ruby,
        "lib/orders.rb",
        "calculate_total",
        "settle_order",
    );
}

#[test]
#[ignore = "requires installed Go and gopls"]
fn go_language_server() {
    verify(
        Language::Go,
        "service/orders.go",
        "calculateTotal",
        "settleOrder",
    );
}

#[test]
#[ignore = "requires installed Go and gopls"]
fn go_hierarchy_traverses_transitive_standard_library_dependencies() {
    let workspace = tempfile::tempdir().unwrap();
    let root = workspace.path().canonicalize().unwrap();
    fs::write(root.join("go.mod"), "module hierarchycheck\n\ngo 1.24\n").unwrap();
    let text = "package hierarchycheck\nimport \"strings\"\nfunc normalize(value string) string { return strings.TrimSpace(value) }\n";
    let path = root.join("normalize.go");
    fs::write(&path, text).unwrap();
    let cache = tempfile::tempdir().unwrap();
    let mut command = server_command(Language::Go, None).unwrap();
    command
        .env("GOPLSCACHE", cache.path().join("gopls"))
        .env("GOCACHE", cache.path().join("build"))
        .env("GOTELEMETRY", "off");
    let mut client = LspClient::start_with_options(
        &root,
        Language::Go,
        command,
        server_initialization_options(Language::Go, None),
    )
    .unwrap();
    client.open(&path, text).unwrap();
    let position = byte_offset_to_position(text, text.find("TrimSpace").unwrap() + 1);
    let prepared = request_until(
        &client,
        "textDocument/prepareCallHierarchy",
        json!({ "textDocument": { "uri": path_to_uri(&path).unwrap() }, "position": position }),
        |value| value.as_array().is_some_and(|items| !items.is_empty()),
    );
    let dependency = prepared[0].clone();
    assert!(
        dependency["name"]
            .as_str()
            .is_some_and(|name| name.ends_with("TrimSpace")),
        "{dependency}"
    );
    assert!(
        !dependency["uri"]
            .as_str()
            .unwrap()
            .starts_with(&path_to_uri(&root).unwrap())
    );
    let outgoing = request_until(
        &client,
        "callHierarchy/outgoingCalls",
        json!({ "item": dependency }),
        |value| value.as_array().is_some_and(|items| !items.is_empty()),
    );
    let trim_func = outgoing
        .as_array()
        .unwrap()
        .iter()
        .find(|call| {
            call["to"]["name"]
                .as_str()
                .is_some_and(|name| name.ends_with("TrimFunc"))
        })
        .expect("TrimSpace must expose its transitive TrimFunc dependency")["to"]
        .clone();
    let transitive = request_until(
        &client,
        "callHierarchy/outgoingCalls",
        json!({ "item": trim_func }),
        |value| value.as_array().is_some_and(|items| !items.is_empty()),
    );
    assert!(
        transitive.to_string().contains("TrimLeftFunc"),
        "{transitive}"
    );
    assert!(
        transitive.to_string().contains("TrimRightFunc"),
        "{transitive}"
    );
    println!(
        "Go: dependency hierarchy crossed the workspace boundary and two standard-library levels"
    );
}
