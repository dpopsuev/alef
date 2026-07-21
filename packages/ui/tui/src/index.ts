// Core TUI interfaces and classes

// Types
export type { ImageAttachment } from "./types/attachment.js";

// Theme primitives
export {
	bg,
	bold,
	type ColorDepth,
	type ColorToken,
	color,
	colorDepth,
	dim,
	FG_RESET,
	fgCode,
	hexToRgb,
	italic,
	nerdFontsAvailable,
} from "./ansi.js";
// Autocomplete support
export {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	type SlashCommand,
} from "./autocomplete.js";
export { Badge, type BadgeOptions } from "./components/badge.js";
export { type BorderStyle, Box, type BoxOptions } from "./components/box.js";
export { CancellableLoader } from "./components/cancellable-loader.js";
export { Collapsible, type CollapsibleOptions } from "./components/collapsible.js";
export { Dialog, type DialogAction, type DialogOptions, type DialogTheme } from "./components/dialog.js";
export {
	ApprovalDialog,
	type ApprovalDialogOptions,
	type ApprovalDialogTheme,
	type ApprovalAction,
	type ToolCallInfo,
} from "./components/approval-dialog.js";
export { Editor, type EditorOptions, type EditorTheme } from "./components/editor.js";
export { IdleGhostHint, type IdleGhostHintOptions } from "./components/idle-ghost-hint.js";
export { Envelope, type EnvelopeOptions } from "./components/envelope.js";
export { FlowEdge, type FlowEdgeOptions } from "./components/flow-edge.js";
export { FlowJunction, type FlowJunctionOptions } from "./components/flow-junction.js";
export { type FlowElement, FlowLayout, type FlowLayoutOptions } from "./components/flow-layout.js";
export { FlowLoop, type FlowLoopOptions } from "./components/flow-loop.js";
export { FlowNode, type FlowNodeOptions } from "./components/flow-node.js";
export { GrowSpacer } from "./components/grow-spacer.js";
export { Image, type ImageOptions, type ImageTheme } from "./components/image.js";
export { Input } from "./components/input.js";
export { Loader, type LoaderIndicatorOptions } from "./components/loader.js";
export { type DefaultTextStyle, Markdown, type MarkdownTheme } from "./components/markdown.js";
export { Menu, type MenuItem, type MenuOptions, type MenuTheme } from "./components/menu.js";
export { type NotificationEntry, type NotificationOptions, NotificationQueue } from "./components/notification.js";
export {
	type PendingQueueEntry,
	type PendingQueueOptions,
	PendingQueuePanel,
	type PendingQueueTheme,
} from "./components/pending-queue.js";
// Components
export { Pad } from "./components/pad.js";
export { type PickerMode, PreviewSelectList, type PreviewSelectListOptions } from "./components/preview-select-list.js";
export { ProgressBar, type ProgressBarOptions } from "./components/progress-bar.js";
export { ScrollView, type ScrollViewOptions } from "./components/scroll-view.js";
export {
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SelectListTheme,
	type SelectListTruncatePrimaryContext,
} from "./components/select-list.js";
export { SeparatorLine, type SeparatorLineOptions } from "./components/separator-line.js";
export { type SettingItem, SettingsList, type SettingsListTheme } from "./components/settings-list.js";
export {
	glyphInterpolator,
	numericInterpolator,
	SlotMachine,
	type SlotMachineOptions,
} from "./components/slot-machine.js";
export { Spacer } from "./components/spacer.js";
export { AgentCard, type AgentCardState, type AgentCardTheme } from "./components/agent-card.js";
export { SplitPane, type SplitPaneOptions } from "./components/split-pane.js";
export { Table, type TableColumn, type TableOptions } from "./components/table.js";
export { Text } from "./components/text.js";
export { Toast, type ToastOptions, type ToastTheme } from "./components/toast.js";
export { type TreeNode, TreeView, type TreeViewOptions } from "./components/tree-view.js";
export { TruncatedText } from "./components/truncated-text.js";
// Design system primitives
export * from "./design/index.js";
// Editor component interface (for custom editors)
export type { EditorComponent } from "./editor-component.js";
// Fuzzy matching
export {
	exactMatch,
	extendedFilter,
	type FuzzyMatch,
	fuzzyFilter,
	fuzzyMatch,
	type MatchStrategy,
	parseSearchTokens,
	prefixMatch,
	regexMatch,
	type SearchToken,
	suffixMatch,
} from "./fuzzy.js";
// Keybindings
export {
	APP_KEYBINDINGS,
	getKeybindings,
	type Keybinding,
	type KeybindingConflict,
	type KeybindingDefinition,
	type KeybindingDefinitions,
	type Keybindings,
	type KeybindingsConfig,
	KeyMap,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "./keybindings.js";
// Keyboard input handling
export {
	decodeKittyPrintable,
	isKeyRelease,
	isKeyRepeat,
	isKittyProtocolActive,
	Key,
	type KeyEventType,
	type KeyId,
	matchesKey,
	parseKey,
	setKittyProtocolActive,
} from "./keys.js";
// Layout engine
export * from "./layout/index.js";
// Reactive state
export { Derived, Store } from "./reactive.js";
// Input buffering for batch splitting
export { StdinBuffer, type StdinBufferEventMap, type StdinBufferOptions } from "./stdin-buffer.js";
// Terminal interface and implementations
export { ProcessTerminal, type Terminal } from "./terminal.js";
// Trace bridge — pluggable trace sink for render error visibility
export { setTraceSink } from "./trace-bridge.js";
// Terminal image support
export {
	allocateImageId,
	type CellDimensions,
	calculateImageRows,
	deleteAllKittyImages,
	deleteKittyImage,
	detectCapabilities,
	encodeITerm2,
	encodeKitty,
	getCapabilities,
	getCellDimensions,
	getGifDimensions,
	getImageDimensions,
	getJpegDimensions,
	getPngDimensions,
	getWebpDimensions,
	hyperlink,
	type ImageDimensions,
	type ImageProtocol,
	type ImageRenderOptions,
	imageFallback,
	renderImage,
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
	type TerminalCapabilities,
} from "./terminal-image.js";
export type { ThemeTokens } from "./theme-types.js";
export {
	type Component,
	Container,
	CURSOR_MARKER,
	type Focusable,
	isFocusable,
	type OverlayAnchor,
	type OverlayHandle,
	type OverlayMargin,
	type OverlayOptions,
	type RenderMeta,
	type SizeValue,
	TUI,
	type RenderHandle,
} from "./tui.js";
// Utilities
export { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "./utils.js";
export { ViModal, type ViModalOptions, type ViMode } from "./vi-modal.js";
