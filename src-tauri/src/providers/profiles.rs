use super::driver::{Protocol, ReasoningMode, is_native_openai, validate_endpoint};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager, State, WebviewWindow};

const KEY_SERVICE: &str = "dev.workbench.ide.providers";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderProfile {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) protocol: Protocol,
    pub(crate) endpoint: String,
    #[serde(default)]
    pub(crate) models: Vec<String>,
    #[serde(default)]
    pub(crate) reasoning: ReasoningMode,
    #[serde(default = "default_output")]
    pub(crate) max_output_tokens: u32,
    pub(crate) api_key_env: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) chatgpt_registration_id: Option<String>,
    #[serde(default, skip_deserializing)]
    pub(crate) has_key: bool,
    #[serde(skip)]
    pub(crate) credential_ref: Option<String>,
}

fn default_output() -> u32 {
    4096
}

pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}

pub(crate) fn validate(profile: &mut ProviderProfile) -> Result<(), String> {
    if profile.id.is_empty() {
        profile.id = uuid::Uuid::new_v4().to_string();
    }
    profile.name = profile.name.trim().into();
    if !valid_id(&profile.id)
        || profile.name.is_empty()
        || profile.name.len() > 80
        || profile.name.chars().any(char::is_control)
    {
        return Err(
            "Use a provider name of at most 80 bytes and a valid profile identifier.".into(),
        );
    }
    let mut endpoint = validate_endpoint(profile.endpoint.trim())?;
    if !endpoint.path().ends_with('/') {
        endpoint.set_path(&format!("{}/", endpoint.path()));
    }
    profile.endpoint = endpoint.to_string();
    let mut seen = HashSet::new();
    profile.models = profile
        .models
        .iter()
        .map(|m| m.trim().to_string())
        .collect();
    if profile.models.len() > 128
        || profile.models.iter().any(|m| {
            m.is_empty()
                || m.len() > 200
                || m.chars().any(char::is_control)
                || !seen.insert(m.clone())
        })
    {
        return Err("Configure at most 128 unique model IDs, each at most 200 bytes.".into());
    }
    if !(256..=65_536).contains(&profile.max_output_tokens) {
        return Err("The output token limit must be between 256 and 65,536.".into());
    }
    if let Some(name) = profile.api_key_env.as_mut() {
        *name = name.trim().to_string();
        if name.is_empty() {
            profile.api_key_env = None;
        } else if name.len() > 128
            || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            || name.as_bytes()[0].is_ascii_digit()
        {
            return Err(
                "Use an environment variable name containing letters, numbers, and underscores."
                    .into(),
            );
        }
    }
    if matches!(profile.protocol, Protocol::Anthropic)
        && matches!(profile.reasoning, ReasoningMode::Openai)
        || matches!(profile.protocol, Protocol::OpenaiCompatible)
            && matches!(profile.reasoning, ReasoningMode::Anthropic)
    {
        return Err("The reasoning format must match the provider protocol.".into());
    }
    validate_subscription(profile)?;
    profile.has_key = false;
    Ok(())
}

fn validate_subscription(profile: &ProviderProfile) -> Result<(), String> {
    let Some(registration_id) = &profile.chatgpt_registration_id else {
        return Ok(());
    };
    if !valid_id(registration_id) {
        return Err("Choose a valid ChatGPT account registration.".into());
    }
    if profile.protocol != Protocol::OpenaiCompatible
        || !is_native_openai(&validate_endpoint(&profile.endpoint)?)
    {
        return Err(
            "ChatGPT sign-in requires the OpenAI protocol and https://api.openai.com/v1/.".into(),
        );
    }
    if profile.api_key_env.is_some() || profile.credential_ref.is_some() {
        return Err(
            "ChatGPT sign-in cannot be combined with an API key or environment variable.".into(),
        );
    }
    Ok(())
}

fn key_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEY_SERVICE, id)
        .map_err(|_| "The system credential store is unavailable.".into())
}

fn saved_key(id: &str) -> Result<Option<String>, String> {
    match key_entry(id)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => {
            Err("The saved provider key could not be read from the system credential store.".into())
        }
    }
}

fn clear_key(id: &str) -> Result<(), String> {
    match key_entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => {
            Err("The provider key could not be removed from the system credential store.".into())
        }
    }
}

pub(crate) fn credentials(profile: &ProviderProfile) -> Result<Option<String>, String> {
    if profile.chatgpt_registration_id.is_some() {
        validate_subscription(profile)?;
        return Ok(None);
    }
    let key = if let Some(name) = &profile.api_key_env {
        Some(std::env::var(name).map_err(|_| "The provider API key environment variable is not set. Restart ejm-ide after setting it.")?)
    } else if let Some(reference) = &profile.credential_ref {
        saved_key(reference)?
    } else {
        None
    };
    if key.as_ref().is_some_and(|key| {
        key.trim().is_empty() || key.len() > 8192 || key.chars().any(char::is_control)
    }) {
        return Err("The provider API key is empty or has invalid characters.".into());
    }
    Ok(key)
}

#[derive(Default)]
pub(crate) struct ProviderState(Mutex<()>);

fn profile_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|_| "The application config folder is unavailable.")?
        .join("providers.json"))
}

fn read_profiles(app: &AppHandle) -> Result<Vec<ProviderProfile>, String> {
    let path = profile_path(app)?;
    let bytes = match std::fs::read(path) {
        Ok(bytes) if bytes.len() <= 512 * 1024 => bytes,
        Ok(_) => return Err("The provider configuration exceeds its size limit.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err("The provider configuration could not be read.".into()),
    };
    decode_profiles(&bytes)
}

fn decode_profiles(bytes: &[u8]) -> Result<Vec<ProviderProfile>, String> {
    let values: Vec<serde_json::Value> = serde_json::from_slice(bytes)
        .map_err(|_| "The saved provider configuration is invalid.")?;
    if values.len() > 32 {
        return Err("At most 32 provider profiles are supported.".into());
    }
    let mut profiles = Vec::with_capacity(values.len());
    let mut ids = HashSet::new();
    for mut value in values {
        let fields = value
            .as_object_mut()
            .ok_or("The saved provider configuration is invalid.")?;
        fields.remove("hasKey");
        let reference = match fields.remove("credentialRef") {
            None | Some(serde_json::Value::Null) => None,
            Some(serde_json::Value::String(reference)) if valid_id(&reference) => Some(reference),
            _ => return Err("The saved provider credential reference is invalid.".into()),
        };
        let mut profile: ProviderProfile = serde_json::from_value(value)
            .map_err(|_| "The saved provider configuration is invalid.")?;
        validate(&mut profile)?;
        profile.credential_ref = reference;
        validate_subscription(&profile)?;
        if !ids.insert(profile.id.clone()) {
            return Err("Provider identifiers must be unique.".into());
        }
        profiles.push(profile);
    }
    Ok(profiles)
}

fn encode_profiles(profiles: &[ProviderProfile]) -> Result<Vec<u8>, String> {
    let mut values = Vec::with_capacity(profiles.len());
    for profile in profiles {
        let mut value =
            serde_json::to_value(profile).map_err(|_| "Provider config could not be encoded.")?;
        value
            .as_object_mut()
            .ok_or("Provider config could not be encoded.")?
            .remove("hasKey");
        if let Some(reference) = &profile.credential_ref {
            value["credentialRef"] = serde_json::Value::String(reference.clone());
        }
        values.push(value);
    }
    serde_json::to_vec_pretty(&values).map_err(|_| "Provider config could not be encoded.".into())
}

enum ProfilePublication {
    Synced,
    Unsynced(String),
}

fn write_profiles(
    app: &AppHandle,
    profiles: &[ProviderProfile],
) -> Result<ProfilePublication, String> {
    write_profiles_at(&profile_path(app)?, profiles, sync_profile_directory)
}

fn sync_profile_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Provider config directory synchronization is unavailable on this target.",
        ))
    }
}

fn write_profiles_at(
    path: &Path,
    profiles: &[ProviderProfile],
    sync_directory: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<ProfilePublication, String> {
    use std::io::Write;
    let parent = path
        .parent()
        .ok_or("The provider config folder is unavailable.")?;
    std::fs::create_dir_all(parent)
        .map_err(|_| "The provider config folder could not be created.")?;
    let bytes = encode_profiles(profiles)?;
    // NamedTempFile creates private files on Unix and removes failed staging files.
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "Provider config could not be saved.")?;
    temporary
        .write_all(&bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| "Provider config could not be saved.")?;
    temporary
        .persist(path)
        .map_err(|_| "Provider config could not be replaced.")?;
    // Replacement is visible. An uncertain sync must not trigger credential rollback.
    if sync_directory(parent).is_err() {
        return Ok(ProfilePublication::Unsynced(
            "The saved provider configuration changed, but its durability could not be confirmed. Saved credentials were retained. Close and reopen Model connections before retrying."
                .into(),
        ));
    }
    Ok(ProfilePublication::Synced)
}

pub(crate) async fn load(
    app: &AppHandle,
    id: &str,
) -> Result<(ProviderProfile, Option<String>), String> {
    if !valid_id(id) {
        return Err("Choose a configured provider first.".into());
    }
    let id = id.to_owned();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ProviderState>();
        let _lock = state
            .0
            .lock()
            .map_err(|_| "Provider configuration is unavailable.")?;
        let profile = read_profiles(&app)?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or("This provider profile no longer exists.")?;
        let key = credentials(&profile)?;
        Ok((profile, key))
    })
    .await
    .map_err(|_| "Provider configuration could not be loaded.")?
}

#[tauri::command]
pub(crate) async fn provider_list(
    app: AppHandle,
    window: WebviewWindow,
    auth: String,
    host: State<'_, crate::HostAccessState>,
) -> Result<Vec<ProviderProfile>, String> {
    host.check(&window, &auth)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ProviderState>();
        let _lock = state
            .0
            .lock()
            .map_err(|_| "Provider configuration is unavailable.")?;
        let mut profiles = read_profiles(&app)?;
        for profile in &mut profiles {
            profile.has_key = profile
                .credential_ref
                .as_deref()
                .and_then(|reference| saved_key(reference).ok().flatten())
                .is_some();
        }
        Ok(profiles)
    })
    .await
    .map_err(|_| "Provider configuration could not be loaded.")?
}

#[tauri::command]
pub(crate) async fn provider_save(
    app: AppHandle,
    window: WebviewWindow,
    auth: String,
    host: State<'_, crate::HostAccessState>,
    mut profile: ProviderProfile,
    api_key: Option<String>,
    clear_key: Option<bool>,
) -> Result<ProviderProfile, String> {
    host.check(&window, &auth)?;
    validate(&mut profile)?;
    if api_key.as_ref().is_some_and(|key| {
        key.len() > 8192 || key.trim().is_empty() || key.chars().any(char::is_control)
    }) {
        return Err("Enter a valid provider API key, or leave the field unchanged.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ProviderState>();
        let _lock = state
            .0
            .lock()
            .map_err(|_| "Provider configuration is unavailable.")?;
        let profiles = read_profiles(&app)?;
        save_profile(
            profiles,
            profile,
            api_key.as_deref(),
            clear_key == Some(true),
            |reference, key| {
                key_entry(reference)?.set_password(key).map_err(|_| {
                    "The provider key could not be saved in the system credential store.".into()
                })
            },
            clear_key_fn,
            |profiles| write_profiles(&app, profiles),
        )
    })
    .await
    .map_err(|_| "The provider profile could not be saved.")?
}

fn clear_key_fn(id: &str) -> Result<(), String> {
    clear_key(id)
}

fn save_profile(
    mut profiles: Vec<ProviderProfile>,
    mut profile: ProviderProfile,
    api_key: Option<&str>,
    clear_key: bool,
    mut put: impl FnMut(&str, &str) -> Result<(), String>,
    mut remove: impl FnMut(&str) -> Result<(), String>,
    commit: impl FnOnce(&[ProviderProfile]) -> Result<ProfilePublication, String>,
) -> Result<ProviderProfile, String> {
    let previous = profiles.iter().find(|item| item.id == profile.id);
    if previous.is_none() && profiles.len() >= 32 {
        return Err("Remove a provider before adding more than 32 profiles.".into());
    }
    let previous_ref = previous.and_then(|item| item.credential_ref.clone());
    if profile.chatgpt_registration_id.is_some() {
        validate_subscription(&profile)?;
        if api_key.is_some() {
            return Err("ChatGPT sign-in cannot be combined with a new API key.".into());
        }
        if previous_ref.is_some() && !clear_key {
            return Err(
                "Clear the saved API key when switching this provider to ChatGPT sign-in.".into(),
            );
        }
    }
    if previous.is_some_and(|previous| {
        previous.endpoint != profile.endpoint || previous.protocol != profile.protocol
    }) && previous_ref.is_some()
        && api_key.is_none()
        && !clear_key
    {
        return Err("Enter a new API key or clear the saved key when changing the provider endpoint or protocol.".into());
    }
    // A new key gets its own slot so a failed config commit leaves the active credential intact.
    let staged_ref = if let Some(key) = api_key {
        let reference = uuid::Uuid::new_v4().to_string();
        if let Err(error) = put(&reference, key) {
            return match remove(&reference) {
                Ok(()) => Err(error),
                Err(_) => Err(format!(
                    "{error} The staged credential could not be removed."
                )),
            };
        }
        Some(reference)
    } else {
        None
    };
    profile.credential_ref = if staged_ref.is_some() {
        staged_ref.clone()
    } else if clear_key {
        None
    } else {
        previous_ref.clone()
    };
    profile.has_key = profile.credential_ref.is_some();
    profiles.retain(|item| item.id != profile.id);
    profiles.push(profile.clone());
    match commit(&profiles) {
        Ok(ProfilePublication::Synced) => {}
        Ok(ProfilePublication::Unsynced(error)) => return Err(error),
        Err(error) => {
            if let Some(reference) = &staged_ref
                && remove(reference).is_err()
            {
                return Err(format!(
                    "{error} The staged credential could not be removed."
                ));
            }
            return Err(error);
        }
    }
    if let Some(reference) = previous_ref
        && Some(&reference) != profile.credential_ref.as_ref()
    {
        remove(&reference).map_err(|_| "The provider profile was saved, but its previous credential could not be removed from the system credential store.")?;
    }
    Ok(profile)
}

fn remove_profile(
    mut profiles: Vec<ProviderProfile>,
    id: &str,
    commit: impl FnOnce(&[ProviderProfile]) -> Result<ProfilePublication, String>,
    mut remove: impl FnMut(&str) -> Result<(), String>,
) -> Result<(), String> {
    let previous = profiles
        .iter()
        .find(|profile| profile.id == id)
        .ok_or("This provider profile no longer exists.")?;
    let previous_ref = previous.credential_ref.clone();
    profiles.retain(|profile| profile.id != id);
    match commit(&profiles)? {
        ProfilePublication::Synced => {}
        ProfilePublication::Unsynced(error) => return Err(error),
    }
    if let Some(reference) = previous_ref {
        remove(&reference).map_err(|_| "The provider profile was removed, but its credential could not be removed from the system credential store.")?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn provider_remove(
    app: AppHandle,
    window: WebviewWindow,
    auth: String,
    host: State<'_, crate::HostAccessState>,
    provider_id: String,
) -> Result<(), String> {
    host.check(&window, &auth)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ProviderState>();
        let _lock = state
            .0
            .lock()
            .map_err(|_| "Provider configuration is unavailable.")?;
        let profiles = read_profiles(&app)?;
        remove_profile(
            profiles,
            &provider_id,
            |profiles| write_profiles(&app, profiles),
            clear_key_fn,
        )
    })
    .await
    .map_err(|_| "The provider profile could not be removed.")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::{Cell, RefCell},
        collections::HashMap,
    };
    fn profile(endpoint: &str) -> ProviderProfile {
        ProviderProfile {
            id: "test".into(),
            name: "Local".into(),
            protocol: Protocol::OpenaiCompatible,
            endpoint: endpoint.into(),
            models: vec!["model".into()],
            reasoning: ReasoningMode::None,
            max_output_tokens: 4096,
            api_key_env: None,
            chatgpt_registration_id: None,
            has_key: false,
            credential_ref: None,
        }
    }
    #[test]
    fn endpoints_require_tls_except_loopback_and_cannot_embed_secrets() {
        for endpoint in [
            "http://api.example.test/v1",
            "https://key@api.example.test",
            "https://api.example.test?key=secret",
            "https://api.example.test#key",
            "file:///tmp/a",
        ] {
            assert!(validate(&mut profile(endpoint)).is_err(), "{endpoint}");
        }
        for endpoint in [
            "https://api.example.test/v1",
            "http://localhost:11434/v1",
            "http://127.0.0.1:1234/v1",
            "http://[::1]:1234/v1",
        ] {
            let mut p = profile(endpoint);
            validate(&mut p).unwrap();
            assert!(p.endpoint.ends_with('/'));
        }
    }
    #[test]
    fn models_and_reasoning_are_validated_without_guessing_capabilities() {
        let mut p = profile("https://api.example.test/v1");
        p.models.push("model".into());
        assert!(validate(&mut p).is_err());
        p.models.clear();
        p.reasoning = ReasoningMode::Anthropic;
        assert!(validate(&mut p).is_err());
        p.reasoning = ReasoningMode::None;
        p.api_key_env = Some("TOKEN;echo secret".into());
        assert!(validate(&mut p).is_err());
    }
    #[test]
    fn config_contains_no_credential_field() {
        let mut profile = profile("https://api.example.test/v1");
        profile.credential_ref = Some("native-reference".into());
        let value = serde_json::to_value(profile).unwrap();
        assert!(value.get("apiKey").is_none());
        assert!(value.get("credentialRef").is_none());
        assert_eq!(value["hasKey"], false);
    }

    #[test]
    fn credential_reference_is_native_config_only() {
        let mut original = profile("https://api.example.test/v1/");
        original.credential_ref = Some("native-reference".into());
        let encoded = encode_profiles(&[original.clone()]).unwrap();
        let raw: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(raw[0]["credentialRef"], "native-reference");
        let decoded = decode_profiles(&encoded).unwrap();
        assert_eq!(
            decoded[0].credential_ref.as_deref(),
            Some("native-reference")
        );
        let mut ipc = serde_json::to_value(original).unwrap();
        ipc["credentialRef"] = serde_json::json!("foreign-reference");
        if let Ok(untrusted) = serde_json::from_value::<ProviderProfile>(ipc) {
            assert!(untrusted.credential_ref.is_none());
        }
    }

    #[test]
    fn subscription_profiles_require_canonical_openai_and_no_api_key_binding() {
        for endpoint in ["https://api.openai.com/v1/", "https://api.openai.com/v1"] {
            let mut profile = profile(endpoint);
            profile.chatgpt_registration_id = Some("registration-id".into());
            validate(&mut profile).unwrap();
            assert!(credentials(&profile).unwrap().is_none());
            let decoded = decode_profiles(&encode_profiles(&[profile]).unwrap()).unwrap();
            assert_eq!(
                decoded[0].chatgpt_registration_id.as_deref(),
                Some("registration-id")
            );
        }
        for endpoint in [
            "https://api.example.test/v1/",
            "https://api.openai.com:444/v1/",
            "https://api.openai.com/v1/extra/",
            "http://127.0.0.1:1234/v1/",
        ] {
            let mut profile = profile(endpoint);
            profile.chatgpt_registration_id = Some("registration-id".into());
            assert!(validate(&mut profile).is_err(), "{endpoint}");
        }
        let mut profile = profile("https://api.openai.com/v1/");
        profile.chatgpt_registration_id = Some("registration-id".into());
        profile.protocol = Protocol::Anthropic;
        assert!(validate(&mut profile).is_err());
        profile.protocol = Protocol::OpenaiCompatible;
        profile.api_key_env = Some("OPENAI_API_KEY".into());
        assert!(validate(&mut profile).is_err());
        profile.api_key_env = None;
        profile.credential_ref = Some("saved-reference".into());
        assert!(validate(&mut profile).is_err());
        let encoded = encode_profiles(&[profile]).unwrap();
        assert!(decode_profiles(&encoded).is_err());
    }

    struct Persistence {
        profiles: RefCell<Vec<ProviderProfile>>,
        keys: RefCell<HashMap<String, String>>,
        fail_commit: Cell<bool>,
        fail_put: Cell<bool>,
        fail_remove: Cell<bool>,
    }

    impl Persistence {
        fn configured() -> Self {
            let mut profile = profile("https://old.example.test/v1/");
            profile.credential_ref = Some("existing-reference".into());
            Self {
                profiles: RefCell::new(vec![profile]),
                keys: RefCell::new(HashMap::from([(
                    "existing-reference".into(),
                    "old-key".into(),
                )])),
                fail_commit: Cell::new(false),
                fail_put: Cell::new(false),
                fail_remove: Cell::new(false),
            }
        }

        fn profile(&self) -> ProviderProfile {
            self.profiles.borrow()[0].clone()
        }

        fn commit(&self, profiles: &[ProviderProfile]) -> Result<ProfilePublication, String> {
            if self.fail_commit.get() {
                return Err("Config write failed.".into());
            }
            self.profiles.replace(profiles.to_vec());
            Ok(ProfilePublication::Synced)
        }

        fn publish(
            &self,
            path: &Path,
            profiles: &[ProviderProfile],
            sync_directory: impl FnOnce(&Path) -> std::io::Result<()>,
        ) -> Result<ProfilePublication, String> {
            let publication = write_profiles_at(path, profiles, sync_directory)?;
            self.profiles
                .replace(decode_profiles(&std::fs::read(path).unwrap()).unwrap());
            Ok(publication)
        }

        fn put_key(&self, reference: &str, key: &str) -> Result<(), String> {
            self.keys.borrow_mut().insert(reference.into(), key.into());
            if self.fail_put.get() {
                Err("Key write failed.".into())
            } else {
                Ok(())
            }
        }

        fn remove_key(&self, reference: &str) -> Result<(), String> {
            assert!(
                !self
                    .profiles
                    .borrow()
                    .iter()
                    .any(|profile| profile.credential_ref.as_deref() == Some(reference)),
                "A committed credential must not be removed."
            );
            if self.fail_remove.get() {
                return Err("Key cleanup failed.".into());
            }
            self.keys.borrow_mut().remove(reference);
            Ok(())
        }

        fn save(
            &self,
            profile: ProviderProfile,
            key: Option<&str>,
            clear: bool,
        ) -> Result<ProviderProfile, String> {
            self.save_with_commit(profile, key, clear, |profiles| self.commit(profiles))
        }

        fn save_with_commit(
            &self,
            mut profile: ProviderProfile,
            key: Option<&str>,
            clear: bool,
            commit: impl FnOnce(&[ProviderProfile]) -> Result<ProfilePublication, String>,
        ) -> Result<ProviderProfile, String> {
            validate(&mut profile)?;
            let profiles = self.profiles.borrow().clone();
            save_profile(
                profiles,
                profile,
                key,
                clear,
                |reference, key| self.put_key(reference, key),
                |reference| self.remove_key(reference),
                commit,
            )
        }

        fn remove(&self) -> Result<(), String> {
            self.remove_with_commit(|profiles| self.commit(profiles))
        }

        fn remove_with_commit(
            &self,
            commit: impl FnOnce(&[ProviderProfile]) -> Result<ProfilePublication, String>,
        ) -> Result<(), String> {
            let profiles = self.profiles.borrow().clone();
            remove_profile(profiles, "test", commit, |reference| {
                self.remove_key(reference)
            })
        }

        fn assert_original(&self) {
            assert_eq!(self.profile().endpoint, "https://old.example.test/v1/");
            assert_eq!(
                self.profile().credential_ref.as_deref(),
                Some("existing-reference")
            );
            assert_eq!(
                *self.keys.borrow(),
                HashMap::from([("existing-reference".into(), "old-key".into())])
            );
        }
    }

    #[test]
    fn switching_to_subscription_requires_clearing_the_saved_key_and_rejects_new_keys() {
        let saved = Persistence::configured();
        let mut subscription = saved.profile();
        subscription.endpoint = "https://api.openai.com/v1/".into();
        subscription.chatgpt_registration_id = Some("registration-id".into());
        subscription.credential_ref = None;
        assert!(saved.save(subscription.clone(), None, false).is_err());
        saved.assert_original();
        assert!(
            saved
                .save(subscription.clone(), Some("new-key"), true)
                .is_err()
        );
        saved.assert_original();
        let result = saved.save(subscription, None, true).unwrap();
        assert_eq!(
            result.chatgpt_registration_id.as_deref(),
            Some("registration-id")
        );
        assert!(result.credential_ref.is_none());
        assert!(!result.has_key);
        assert!(saved.keys.borrow().is_empty());
    }

    #[test]
    fn failed_replacement_preserves_old_key_and_removes_staged_key_and_file() {
        let saved = Persistence::configured();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("providers.json");
        // A directory blocks real replacement. This is not a prior JSON-file fixture.
        std::fs::create_dir(&path).unwrap();
        let sentinel = path.join("keep");
        std::fs::write(&sentinel, b"unchanged").unwrap();
        let mut changed = saved.profile();
        changed.endpoint = "https://new.example.test/v1/".into();
        let result = saved.save_with_commit(changed, Some("new-key"), false, |profiles| {
            saved.publish(&path, profiles, |_| {
                panic!("Directory sync must not run after failed replacement.")
            })
        });
        assert!(result.is_err());
        saved.assert_original();
        assert_eq!(std::fs::read(&sentinel).unwrap(), b"unchanged");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn failed_key_save_never_changes_active_config_or_credential() {
        let saved = Persistence::configured();
        saved.fail_put.set(true);
        assert!(saved.save(saved.profile(), Some("new-key"), false).is_err());
        saved.assert_original();
    }

    #[cfg(unix)]
    #[test]
    fn replacement_syncs_complete_config_before_retiring_the_previous_key() {
        use std::os::unix::fs::PermissionsExt;

        let saved = Persistence::configured();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("providers.json");
        std::fs::write(&path, encode_profiles(&saved.profiles.borrow()).unwrap()).unwrap();
        let synced = Cell::new(false);
        let mut changed = saved.profile();
        changed.endpoint = "https://new.example.test/v1/".into();
        validate(&mut changed).unwrap();
        let profiles = saved.profiles.borrow().clone();
        let result = save_profile(
            profiles,
            changed,
            Some("new-key"),
            false,
            |reference, key| saved.put_key(reference, key),
            |reference| {
                assert!(
                    synced.get(),
                    "A prior key must survive until directory sync."
                );
                saved.remove_key(reference)
            },
            |profiles| {
                saved.publish(&path, profiles, |parent| {
                    assert_eq!(parent, directory.path());
                    let visible = decode_profiles(&std::fs::read(&path).unwrap()).unwrap();
                    assert_eq!(visible.len(), 1);
                    assert_eq!(visible[0].endpoint, "https://new.example.test/v1/");
                    let reference = visible[0].credential_ref.as_ref().unwrap();
                    assert_ne!(reference, "existing-reference");
                    assert_eq!(
                        *saved.keys.borrow(),
                        HashMap::from([
                            ("existing-reference".into(), "old-key".into()),
                            (reference.clone(), "new-key".into()),
                        ])
                    );
                    assert_eq!(
                        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                        0o600
                    );
                    sync_profile_directory(parent)?;
                    synced.set(true);
                    Ok(())
                })
            },
        )
        .unwrap();
        assert!(synced.get());
        let reference = result.credential_ref.unwrap();
        assert_ne!(reference, "existing-reference");
        assert_eq!(saved.profile().endpoint, "https://new.example.test/v1/");
        assert_eq!(
            saved.profile().credential_ref.as_deref(),
            Some(reference.as_str())
        );
        assert_eq!(
            *saved.keys.borrow(),
            HashMap::from([(reference, "new-key".into())])
        );
    }

    #[test]
    fn failed_directory_sync_keeps_both_keys_for_the_visible_replacement() {
        let saved = Persistence::configured();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("providers.json");
        std::fs::write(&path, encode_profiles(&saved.profiles.borrow()).unwrap()).unwrap();
        let mut changed = saved.profile();
        changed.endpoint = "https://new.example.test/v1/".into();
        let error = saved
            .save_with_commit(changed, Some("new-key"), false, |profiles| {
                saved.publish(&path, profiles, |_| {
                    let visible = decode_profiles(&std::fs::read(&path).unwrap()).unwrap();
                    assert_eq!(visible.len(), 1);
                    assert_eq!(visible[0].endpoint, "https://new.example.test/v1/");
                    assert!(visible[0].credential_ref.is_some());
                    Err(std::io::Error::other("Injected directory-sync failure."))
                })
            })
            .err()
            .unwrap();
        assert!(error.contains("changed"));
        assert!(error.contains("reopen Model connections"));
        let visible = decode_profiles(&std::fs::read(&path).unwrap()).unwrap();
        let reference = visible[0].credential_ref.as_ref().unwrap();
        assert_ne!(reference, "existing-reference");
        assert_eq!(
            *saved.keys.borrow(),
            HashMap::from([
                ("existing-reference".into(), "old-key".into()),
                (reference.clone(), "new-key".into()),
            ])
        );
        assert_eq!(saved.profile().credential_ref.as_ref(), Some(reference));
    }

    #[test]
    fn clearing_or_removing_retains_the_key_when_visible_config_is_unsynced() {
        for remove in [false, true] {
            let saved = Persistence::configured();
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("providers.json");
            std::fs::write(&path, encode_profiles(&saved.profiles.borrow()).unwrap()).unwrap();
            let commit = |profiles: &[ProviderProfile]| {
                saved.publish(&path, profiles, |_| {
                    Err(std::io::Error::other("Injected directory-sync failure."))
                })
            };
            let result = if remove {
                saved.remove_with_commit(commit)
            } else {
                saved
                    .save_with_commit(saved.profile(), None, true, commit)
                    .map(|_| ())
            };
            assert!(result.unwrap_err().contains("changed"));
            let visible = decode_profiles(&std::fs::read(&path).unwrap()).unwrap();
            if remove {
                assert!(visible.is_empty());
            } else {
                assert_eq!(visible.len(), 1);
                assert!(visible[0].credential_ref.is_none());
            }
            assert_eq!(
                *saved.keys.borrow(),
                HashMap::from([("existing-reference".into(), "old-key".into())])
            );
        }
    }

    #[test]
    fn endpoint_or_protocol_changes_cannot_reuse_a_saved_credential() {
        for protocol_change in [false, true] {
            let saved = Persistence::configured();
            let mut changed = saved.profile();
            if protocol_change {
                changed.protocol = Protocol::Anthropic;
            } else {
                changed.endpoint = "https://new.example.test/v1/".into();
            }
            assert!(saved.save(changed, None, false).is_err());
            saved.assert_original();
        }
    }

    #[test]
    fn unchanged_endpoint_uses_the_saved_reference_and_ignores_the_incoming_one() {
        let saved = Persistence::configured();
        let mut changed = saved.profile();
        changed.credential_ref = Some("foreign-reference".into());
        changed.name = "Renamed".into();
        let result = saved.save(changed, None, false).unwrap();
        assert_eq!(result.credential_ref.as_deref(), Some("existing-reference"));
        assert_eq!(saved.profile().name, "Renamed");
        assert_eq!(saved.keys.borrow().len(), 1);
    }

    #[test]
    fn clearing_or_removing_a_profile_preserves_its_key_when_config_save_fails() {
        for remove in [false, true] {
            let saved = Persistence::configured();
            saved.fail_commit.set(true);
            let result = if remove {
                saved.remove()
            } else {
                saved.save(saved.profile(), None, true).map(|_| ())
            };
            assert!(result.is_err());
            saved.assert_original();
        }
    }

    #[test]
    fn clearing_or_removing_a_profile_commits_before_deleting_its_key() {
        for remove in [false, true] {
            let saved = Persistence::configured();
            if remove {
                saved.remove().unwrap();
                assert!(saved.profiles.borrow().is_empty());
            } else {
                let result = saved.save(saved.profile(), None, true).unwrap();
                assert!(result.credential_ref.is_none());
                assert!(!result.has_key);
                assert!(saved.profile().credential_ref.is_none());
            }
            assert!(saved.keys.borrow().is_empty());
        }
    }

    #[test]
    fn failed_cleanup_reports_the_committed_state_without_rebinding_the_old_key() {
        let saved = Persistence::configured();
        saved.fail_remove.set(true);
        let mut changed = saved.profile();
        changed.endpoint = "https://new.example.test/v1/".into();
        let error = saved.save(changed, Some("new-key"), false).err().unwrap();
        assert!(error.contains("was saved"));
        let current = saved.profile();
        assert_eq!(current.endpoint, "https://new.example.test/v1/");
        let reference = current.credential_ref.unwrap();
        assert_ne!(reference, "existing-reference");
        assert_eq!(
            saved.keys.borrow().get(&reference).map(String::as_str),
            Some("new-key")
        );
        assert_eq!(
            saved
                .keys
                .borrow()
                .get("existing-reference")
                .map(String::as_str),
            Some("old-key")
        );
    }
}
