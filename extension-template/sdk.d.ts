interface WorkbenchReference {
  id: string;
  label: string;
  kind: string;
  origin: string;
  uri?: string;
  content: string;
}
interface WorkbenchExtensionApi {
  getContext(): readonly WorkbenchReference[];
  onContextChange(listener: (references: readonly WorkbenchReference[]) => void): () => void;
  onCommand(listener: (command: string) => void): () => void;
  addToChat(value: { referenceId: string } | { label: string; content: string }): void;
  openSource(referenceId: string): void;
}
interface Window {
  workbench: WorkbenchExtensionApi;
}
