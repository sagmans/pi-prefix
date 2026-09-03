import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { AppKeybinding, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import type {
  AutocompleteProvider,
  EditorComponent,
  EditorTheme,
  KeyId,
  TUI,
} from "@earendil-works/pi-tui";
import type { EffectivePrefixConfig, PrefixTarget } from "./config.ts";

export type PrefixEditorOptions = {
  config: EffectivePrefixConfig;
  emitEvent: (event: string, payload?: unknown) => void;
  setStatus: (text: string | undefined) => void;
  notify: (message: string, type?: "info" | "warning" | "error") => void;
  // WHY: editor-independent commands must not sacrifice the user's draft, so
  // the host decides whether direct dispatch applies before any setText.
  dispatchExtensionCommand: (command: string) => boolean;
};

// WHY: Pi wires these three app actions through replaceable callbacks rather
// than the ordinary actionHandlers map; dispatch must honor the same paths.
const INTERRUPT_ACTION: AppKeybinding = "app.interrupt";
const EXIT_ACTION: AppKeybinding = "app.exit";
const PASTE_IMAGE_ACTION: AppKeybinding = "app.clipboard.pasteImage";
const CANCEL_KEY: KeyId = "escape";
const STATUS_KEY = "pi-prefix";
const ENTER_INPUT = "\r";

// Layer prefix behavior over whichever editor another extension installed.
type WrappedEditor = EditorComponent & {
  actionHandlers?: Map<AppKeybinding, () => void>;
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  disableSubmit?: boolean;
  focused?: boolean;
  onEscape?: () => void;
  onCtrlD?: () => void;
  onPasteImage?: () => void;
  onExtensionShortcut?: (data: string) => boolean;
};

function modifierMask(parts: string[]): number {
  let modifier = 0;
  if (parts.includes("shift")) modifier |= 1;
  if (parts.includes("alt")) modifier |= 2;
  if (parts.includes("ctrl")) modifier |= 4;
  if (parts.includes("super")) modifier |= 8;
  return modifier;
}

function inputForKey(keyId: string): string | undefined {
  const parts = keyId.toLowerCase().split("+");
  const key = parts.pop();
  if (!key) return undefined;
  if (key === "enter" || key === "return") {
    const modifier = modifierMask(parts);
    return modifier === 0 ? ENTER_INPUT : `\x1b[13;${modifier + 1}u`;
  }
  if (parts.length === 1 && parts[0] === "ctrl" && key.length === 1) {
    const code = key.charCodeAt(0);
    if (code >= 97 && code <= 122) return String.fromCharCode(code - 96);
  }
  return undefined;
}

export class PrefixEditor extends CustomEditor {
  private prefixActive = false;
  private prefixTimer: ReturnType<typeof setTimeout> | undefined;
  // WHY: a stale wrapper inside a rebuilt editor chain must never intercept
  // keystrokes against a disposed dispatch surface.
  private disposed = false;

  private readonly appTui: TUI;
  private readonly keybindingsManager: KeybindingsManager;
  private readonly inner: WrappedEditor;
  private readonly options: PrefixEditorOptions;

  constructor(
    appTui: TUI,
    theme: EditorTheme,
    keybindingsManager: KeybindingsManager,
    inner: WrappedEditor,
    options: PrefixEditorOptions,
  ) {
    super(appTui, theme, keybindingsManager);
    this.appTui = appTui;
    this.keybindingsManager = keybindingsManager;
    this.inner = inner;
    this.options = options;
  }

  private syncAppHandlers(): void {
    if (this.inner.actionHandlers instanceof Map) {
      this.inner.actionHandlers.clear();
      for (const [action, handler] of this.actionHandlers) {
        this.inner.actionHandlers.set(action, handler);
      }
    }
    // WHY: the TUI sets focused only on the outermost component; wrappers
    // must forward it or inner editors silently change focus behavior.
    this.inner.focused = this.focused;
    this.inner.onSubmit = this.onSubmit;
    this.inner.onChange = this.onChange;
    this.inner.disableSubmit = this.disableSubmit;
    this.inner.onEscape = this.onEscape;
    this.inner.onCtrlD = this.onCtrlD;
    this.inner.onPasteImage = this.onPasteImage;
    this.inner.onExtensionShortcut = this.onExtensionShortcut;
  }

  activate(): void {
    if (this.disposed) return;
    this.prefixActive = true;
    if (this.prefixTimer) clearTimeout(this.prefixTimer);
    this.prefixTimer = setTimeout(() => this.clearPrefix(), this.options.config.timeoutMs);
    this.options.setStatus(`prefix ${this.options.config.prefix}`);
    this.appTui.requestRender();
  }

  private clearPrefix(): void {
    const wasActive = this.prefixActive;
    this.prefixActive = false;
    if (this.prefixTimer) {
      clearTimeout(this.prefixTimer);
      this.prefixTimer = undefined;
    }
    this.options.setStatus(undefined);
    if (wasActive) this.appTui.requestRender();
  }

  private submitCurrentDraft(): void {
    if (this.disableSubmit) return;
    for (const key of this.keybindingsManager.getKeys("tui.input.submit")) {
      const input = inputForKey(String(key));
      if (input) {
        this.syncAppHandlers();
        this.inner.handleInput(input);
        return;
      }
    }
  }

  private dispatch(target: PrefixTarget): void {
    if ("action" in target) {
      const action = target.action as AppKeybinding;
      const handler =
        action === INTERRUPT_ACTION
          ? (this.onEscape ?? this.actionHandlers.get(action))
          : action === EXIT_ACTION
            ? (this.onCtrlD ?? this.actionHandlers.get(action))
            : action === PASTE_IMAGE_ACTION
              ? (this.onPasteImage ?? this.actionHandlers.get(action))
              : this.actionHandlers.get(action);
      if (handler) {
        this.syncAppHandlers();
        handler();
      } else {
        this.options.notify(`pi-prefix: action "${target.action}" is unavailable`, "warning");
      }
      return;
    }
    if ("command" in target) {
      if (target.submit && this.options.dispatchExtensionCommand(target.command)) {
        return;
      }
      this.setText(target.command);
      if (target.submit) {
        this.submitCurrentDraft();
      }
      return;
    }
    if ("event" in target) {
      this.options.emitEvent(target.event, target.payload);
      return;
    }
    // WHY: exhaustiveness guard so a future target kind fails compilation.
    const exhaustive: never = target;
    return exhaustive;
  }

  handleInput(data: string): void {
    // WHY: Pi delivers registered shortcuts through this callback; honoring
    // it first is what lets native registration activate prefix mode.
    if (this.onExtensionShortcut?.(data)) {
      return;
    }
    if (this.disposed) {
      this.syncAppHandlers();
      this.inner.handleInput(data);
      return;
    }
    if (this.prefixActive) {
      if (matchesKey(data, CANCEL_KEY)) {
        this.clearPrefix();
        return;
      }
      for (const [keyId, target] of this.options.config.bindings) {
        if (matchesKey(data, keyId)) {
          this.clearPrefix();
          this.dispatch(target);
          return;
        }
      }
      this.clearPrefix();
    }
    this.syncAppHandlers();
    this.inner.handleInput(data);
  }

  /** Mark transparent and release the prefix timer; called on session_shutdown. */
  dispose(): void {
    this.disposed = true;
    this.clearPrefix();
  }

  render(width: number): string[] {
    this.inner.borderColor = this.borderColor;
    this.inner.focused = this.focused;
    return this.inner.render(width);
  }

  invalidate(): void {
    this.inner.invalidate();
  }

  getText(): string {
    return this.inner.getText();
  }

  setText(text: string): void {
    this.inner.setText(text);
  }

  addToHistory(text: string): void {
    this.inner.addToHistory?.(text);
  }

  insertTextAtCursor(text: string): void {
    this.inner.insertTextAtCursor?.(text);
  }

  getExpandedText(): string {
    return this.inner.getExpandedText?.() ?? this.inner.getText();
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.inner.setAutocompleteProvider?.(provider);
  }

  setPaddingX(padding: number): void {
    this.inner.setPaddingX?.(padding);
  }

  setAutocompleteMaxVisible(maxVisible: number): void {
    this.inner.setAutocompleteMaxVisible?.(maxVisible);
  }
}
