const { once } = require('node:events');
const { createConnection } = require('node:net');
const {
  createProtocolConnection,
  ExitNotification,
  InitializeRequest,
  ShutdownRequest,
} = require('vscode-languageserver-protocol/node');

const connection = createProtocolConnection(process.stdin, process.stdout);
connection.onRequest(InitializeRequest.type, async () => {
  const control = createConnection({ host: '127.0.0.1', port: Number(process.argv[2]) });
  control.on('end', () => process.exit(2));
  control.on('error', () => process.exit(2));
  await once(control, 'connect');
  control.write(Buffer.from([1]));
  const [release] = await once(control, 'data');
  if (release.length !== 1 || release[0] !== 1) process.exit(2);
  return { capabilities: {} };
});
connection.onRequest(ShutdownRequest.type, () => null);
// Keep the control socket open so the parent can observe LspClient child cleanup.
connection.onNotification(ExitNotification.type, () => undefined);
connection.listen();
