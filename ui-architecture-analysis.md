# UI Architecture Analysis: TUI & Web

## Executive Summary

Both `packages/ui/tui` and `packages/ui/web` implement **observer-pattern reactive UIs** with clean separation between state management, rendering, and session communication. The architecture follows a unidirectional data flow where:

1. **Session layer** (Agent) owns state and emits events
2. **UI layer** subscribes to events and requests re-renders
3. **Rendering** is decoupled through differential/declarative systems

---

## Architecture Overview

### TUI Architecture (Terminal UI)

```
┌─────────────────────────────────────────────────────────────┐
│                      TUI Container                          │
│  ┌────────────────┐  ┌──────────────┐  ┌─────────────────┐ │
│  │   Component    │  │   Reactive   │  │  Differential   │ │
│  │   Tree         │  │   Store      │  │  Renderer       │ │
│  └────────────────┘  └──────────────┘  └─────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Session Layer                            │
│              (AgentSession / SessionHandle)                 │
│  - State: modelId, thinking, contextWindow                  │
│  - Events: chunk, thinking, tool-start, tool-end, etc.      │
│  - Methods: send(), setModel(), subscribe()                 │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                   Engine Layer (Agent)                      │
│  - Bus architecture (command/event/notification)            │
│  - Adapter loading (LLM, tools, directives)                 │
│  - Tool execution orchestration                             │
└─────────────────────────────────────────────────────────────┘
```

### Web Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   ChatPanel (Container)                     │
│  ┌──────────────────────┐  ┌──────────────────────────────┐│
│  │  AgentInterface      │  │  ArtifactsPanel              ││
│  │  (Lit component)     │  │  (Lit component)             ││
│  └──────────────────────┘  └──────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              Agent (from @dpopsuev/alef-ai)                 │
│  - State: model, messages, tools, isStreaming               │
│  - Events: agent_start, message_update, turn_end, etc.      │
│  - Methods: prompt(), abort(), subscribe()                  │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    AppStorage (IndexedDB)                   │
│  - SettingsStore, ProviderKeysStore, SessionsStore          │
│  - Persistence layer for state/sessions                     │
└─────────────────────────────────────────────────────────────┘
```

---

## 1. Rendering Decoupling from State

### TUI: Component Interface + Reactive Stores

**Core Abstraction:**
```typescript
// component.ts
interface Component {
  render(width: number): string[];  // Pure function: state → view
  handleInput?(data: string): void;
  invalidate(): void;               // Clear cache, request re-render
}
```

**State Management:**
```typescript
// reactive.ts - Observable store with batched notifications
class Store<T> {
  private state: T;
  private listeners = new Set<() => void>();
  
  update(partial: Partial<T>): void {
    // Change detection
    if (!changed) return;
    this.state = { ...this.state, ...partial };
    this.scheduleNotify();  // Microtask batching
  }
  
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
```

**Decoupling Mechanism:**

1. **Components own rendering logic** - `render()` is a pure function
2. **State lives in Stores** - `TuiState`, `Store<T>` (views/state.ts, reactive.ts)
3. **Subscription bridges them** - Stores notify → Components invalidate → TUI re-renders

**Example Pattern:**
```typescript
// views/output-panel.ts
const state = new Store({ modelId: "...", inputTokens: 0, ... });

// Component subscribes to state changes
state.subscribe(() => component.invalidate());

// State change triggers re-render chain
state.update({ inputTokens: 1024 });  
// → listener fires 
// → component.invalidate() 
// → tui.requestRender()
```

**Differential Rendering:**

The TUI implements **three-strategy rendering** (tui.ts, `doRender()`):

1. **First render** - Output all lines without clearing
2. **Dimension change** - Full screen clear + re-render
3. **Content change** - Differential update (moves cursor to first changed line)

```typescript
// tui.ts - Differential rendering
private doRender(): void {
  const newLines = this.render(width);  // Component tree renders
  
  // Find first/last changed line
  let firstChanged = -1, lastChanged = -1;
  for (let i = 0; i < Math.max(newLines.length, prevLines.length); i++) {
    if (newLines[i] !== prevLines[i]) {
      if (firstChanged === -1) firstChanged = i;
      lastChanged = i;
    }
  }
  
  if (firstChanged === -1) return;  // No changes
  
  // Only render changed region
  buffer += `\x1b[${lineDiff}B`;  // Move to first changed line
  for (let i = firstChanged; i <= lastChanged; i++) {
    buffer += `\x1b[2K${newLines[i]}\r\n`;
  }
  
  this.terminal.write(buffer);
}
```

**Key Features:**
- **Synchronized output** - Wraps updates in `\x1b[?2026h...l` (DEC 2026) for flicker-free rendering
- **Line-level change detection** - Only redraws changed lines
- **Microtask batching** - Multiple state updates in same tick = one render

---

### Web: Lit Reactive Properties + Event-Driven Updates

**Core Abstraction:**
```typescript
// Lit web components with reactive properties
class AgentInterface extends LitElement {
  @property({ attribute: false }) session?: Agent;
  
  override willUpdate(changedProperties: Map<string, any>) {
    // Re-subscribe when session changes
    if (changedProperties.has("session")) {
      this.setupSessionSubscription();
    }
  }
  
  private setupSessionSubscription() {
    this._unsubscribe = this.session.subscribe((event: AgentEvent) => {
      switch (event.type) {
        case 'message_update':
          this._streamingContainer.setMessage(event.message);
          this.requestUpdate();  // Request Lit re-render
          break;
      }
    });
  }
}
```

**Decoupling Mechanism:**

1. **Agent owns state** - `agent.state.messages`, `agent.state.model`, etc.
2. **Lit components are views** - Declarative templates rendered from state
3. **Event subscription bridges them** - Agent emits events → Components call `requestUpdate()`

**Example Event Flow:**
```typescript
// 1. User sends message
await agent.prompt("Hello");

// 2. Agent emits events during processing
agent.subscribe((event) => {
  switch (event.type) {
    case 'message_start':   // New message started
    case 'message_update':  // Streaming chunk received
    case 'tool_execution_start':  // Tool call started
    case 'message_end':     // Message completed
  }
});

// 3. Component reacts to events
this._unsubscribe = this.session.subscribe((ev) => {
  switch (ev.type) {
    case 'message_update':
      this._streamingContainer.setMessage(ev.message, !isStreaming);
      this.requestUpdate();  // Lit re-render
      break;
  }
});
```

**Declarative Rendering:**

Lit components use declarative templates that automatically update when reactive properties change:

```typescript
override render() {
  return html`
    <message-list
      .messages=${this.session.state.messages}
      .tools=${this.session.state.tools}
      .isStreaming=${this.session.state.isStreaming}
    ></message-list>
  `;
}
```

**Render Splitting Strategy:**

Web UI splits rendering into **stable** and **streaming** containers to avoid re-rendering the entire message list on every streaming update:

```typescript
// components/AgentInterface.ts
renderMessages() {
  return html`
    <!-- Stable messages - won't re-render during streaming -->
    <message-list
      .messages=${this.session.state.messages}
    ></message-list>

    <!-- Streaming container - manages its own updates -->
    <streaming-message-container
      class="${state.isStreaming ? "" : "hidden"}"
      .isStreaming=${state.isStreaming}
    ></streaming-message-container>
  `;
}
```

---

## 2. Event Flow

### TUI Event Flow

```
┌──────────────┐
│   Terminal   │ stdin → escape sequences
└──────┬───────┘
       │ handleInput(data: string)
       ▼
┌──────────────────────┐
│  TUI.handleInput()   │
│  - Global handlers   │  (Ctrl+C, debug keys)
│  - Input listeners   │  (middleware pattern)
└──────┬───────────────┘
       │
       ▼
┌──────────────────────┐
│ Focused Component    │
│  handleInput(data)   │  (Editor, SelectList, etc.)
└──────┬───────────────┘
       │ State changes (e.g., editor.text += char)
       ▼
┌──────────────────────┐
│ component.onChange() │  Optional callback
└──────┬───────────────┘
       │
       ▼
┌──────────────────────┐
│  tui.requestRender() │  Requests re-render on next microtask
└──────┬───────────────┘
       │
       ▼
┌──────────────────────┐
│   doRender()         │  Differential rendering
│  - Component tree    │  calls render() on all components
│  - Change detection  │
│  - Terminal write    │
└──────────────────────┘
```

**Session Event Integration:**

```
┌──────────────────────┐
│  Session.subscribe() │
└──────┬───────────────┘
       │ Events: chunk, thinking, tool-start, tool-end, ...
       ▼
┌──────────────────────────────────────┐
│  View Event Handler                  │
│  (e.g., ChatView, OutputPanel)       │
│  - Update component state            │
│  - Append text to Typewriter         │
│  - Add tool result to chat           │
└──────┬───────────────────────────────┘
       │
       ▼
┌──────────────────────┐
│  tui.requestRender() │
└──────────────────────┘
```

**Example from TUI (inferred pattern):**
```typescript
// session subscribes to agent events
session.subscribe((event: AgentEvent) => {
  switch (event.type) {
    case 'chunk':
      outputPanel.replyTW.write(event.text);  // Typewriter effect
      tui.requestRender();
      break;
    case 'tool-start':
      outputPanel.replyBlock.addTool(event.name, event.args);
      tui.requestRender();
      break;
    case 'tool-end':
      outputPanel.replyBlock.completeTool(event.callId, event.ok);
      tui.requestRender();
      break;
  }
});
```

**Input Listener Pattern:**

TUI supports middleware-style input listeners:

```typescript
// tui.ts
type InputListener = (data: string) => { consume?: boolean; data?: string } | undefined;

tui.addInputListener((data) => {
  // Transform or consume input before it reaches focused component
  if (data === '\x03') { // Ctrl+C
    return { consume: true };  // Block from reaching component
  }
  // Allow passthrough
  return undefined;
});
```

---

### Web Event Flow

```
┌─────────────────┐
│  User Action    │ (button click, input change)
└────────┬────────┘
         │ DOM event
         ▼
┌─────────────────────────┐
│  Lit Event Handler      │
│  @click=${...}          │
│  @input=${...}          │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  Agent Method Call      │
│  agent.prompt(text)     │
│  agent.abort()          │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  Agent Processing       │
│  - Stream LLM response  │
│  - Execute tools        │
│  - Emit events          │
└────────┬────────────────┘
         │ AgentEvent stream
         ▼
┌─────────────────────────┐
│ Component Subscription  │
│ session.subscribe(...)  │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  Event Handler          │
│  - Update local state   │
│  - requestUpdate()      │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  Lit Re-render          │
│  - render() called      │
│  - DOM diff applied     │
└─────────────────────────┘
```

**Concrete Example:**
```typescript
// components/AgentInterface.ts
async sendMessage(input: string, attachments?: Attachment[]) {
  // 1. User action
  if (!input.trim() && !attachments?.length) return;
  
  // 2. Call agent
  await this.session.prompt(input);
  
  // 3. Agent emits events during processing
}

setupSessionSubscription() {
  this._unsubscribe = this.session.subscribe(async (ev: AgentEvent) => {
    // 4. React to events
    switch (ev.type) {
      case 'message_start':
      case 'turn_start':
      case 'turn_end':
        this.requestUpdate();  // 5. Re-render
        break;
      case 'message_update':
        this._streamingContainer.setMessage(ev.message);
        this.requestUpdate();
        break;
    }
  });
}
```

---

## 3. UI ↔ Session Communication

### TUI: Session Interface Pattern

**Session Interface (contracts/session.ts):**
```typescript
interface Session {
  readonly state: SessionState;
  
  // State accessors
  getModel(): string;
  setModel(id: string): void;
  getThinking(): string;
  setThinking(level: string): void;
  
  // Communication
  send?(text: string, timeoutMs?: number): Promise<string>;
  receive?(text: string): void;
  
  // Event subscription
  subscribe(observer: (event: AgentEvent) => void): () => void;
  
  // Lifecycle
  dispose(): void;
}
```

**Event Types (AgentEvent):**
```typescript
type AgentEvent =
  | { type: "chunk"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool-start"; callId: string; name: string; args: Record<string, unknown> }
  | { type: "tool-end"; callId: string; elapsedMs: number; ok: boolean; display?: string }
  | { type: "turn-complete"; reply: string }
  | { type: "turn-error"; message: string }
  | { type: "token-usage"; usage: TokensConsumed }
  | { type: "state-changed"; modelId: string; thinking: string; contextWindow: number }
  // ... 20+ event types
```

**Communication Pattern:**

1. **UI → Session (Commands):**
   ```typescript
   // Send user input
   await session.send("What is 2+2?");
   
   // Change model
   session.setModel("anthropic:claude-sonnet-4");
   
   // Change thinking level
   session.setThinking("medium");
   ```

2. **Session → UI (Events):**
   ```typescript
   // Subscribe to events
   const unsubscribe = session.subscribe((event: AgentEvent) => {
     switch (event.type) {
       case 'chunk':
         // Append streaming text
         chatView.appendChunk(event.text);
         break;
       case 'tool-start':
         // Show tool execution indicator
         chatView.addToolCall(event.callId, event.name);
         break;
       case 'tool-end':
         // Show tool result
         chatView.completeToolCall(event.callId, event.ok);
         break;
     }
   });
   ```

**Implementation (AgentSession):**
```typescript
// core/session/src/agent.ts
export class AgentSession implements Session {
  private readonly _observers: Set<(event: AgentEvent) => void>;
  
  subscribe(observer: (event: AgentEvent) => void): () => void {
    this._observers.add(observer);
    return () => this._observers.delete(observer);
  }
  
  notify(event: AgentEvent): void {
    for (const obs of this._observers) obs(event);
  }
  
  async send(text: string, timeoutMs?: number): Promise<string> {
    return this._deps.send(text, "human", timeoutMs);
  }
}
```

---

### Web: Agent Property Binding + Event Subscription

**Agent Interface (agent-types.ts):**
```typescript
interface Agent {
  state: AgentState;
  subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void;
  prompt(input: string | AgentMessage): Promise<void>;
  abort(): void;
  steer(message: AgentMessage): void;
  streamFn?: unknown;
  getApiKey?: (provider: string) => string | Promise<string | undefined> | undefined;
}

interface AgentState {
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool[];
  messages: AgentMessage[];
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
}
```

**Event Types (AgentEvent):**
```typescript
type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: any[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; result: any; isError: boolean }
```

**Communication Pattern:**

1. **UI → Agent (Commands):**
   ```typescript
   // Send user message
   await agent.prompt("Hello!");
   
   // Send with attachments
   await agent.prompt({
     role: 'user-with-attachments',
     content: 'Analyze this',
     attachments: [pdfAttachment],
     timestamp: Date.now()
   });
   
   // Cancel ongoing request
   agent.abort();
   
   // Change model
   agent.state.model = newModel;
   
   // Change thinking level
   agent.state.thinkingLevel = 'medium';
   ```

2. **Agent → UI (Events):**
   ```typescript
   // components/AgentInterface.ts
   setupSessionSubscription() {
     this._unsubscribe = this.session.subscribe(async (ev: AgentEvent) => {
       switch (ev.type) {
         case 'message_start':
         case 'turn_start':
         case 'turn_end':
         case 'agent_start':
           this.requestUpdate();  // Full re-render
           break;
           
         case 'message_end':
           // Clear streaming container
           this._streamingContainer.setMessage(null, true);
           this.requestUpdate();
           break;
           
         case 'message_update':
           // Update streaming message
           const isStreaming = this.session?.state.isStreaming || false;
           this._streamingContainer.isStreaming = isStreaming;
           this._streamingContainer.setMessage(ev.message, !isStreaming);
           this.requestUpdate();
           break;
       }
     });
   }
   ```

**Property Binding:**

```typescript
// ChatPanel.ts
await chatPanel.setAgent(agent, {
  // Callbacks for UI integration
  onApiKeyRequired: (provider) => ApiKeyPromptDialog.prompt(provider),
  onBeforeSend: async () => { /* save draft */ },
  onCostClick: () => { /* show cost breakdown */ },
});

// AgentInterface automatically binds to agent state
chat.session = agent;  // Lit reactive property
```

---

## 4. Key Architectural Patterns

### Observer Pattern (Both)

**TUI:**
```typescript
// reactive.ts - Store notifies subscribers on state changes
class Store<T> {
  subscribe(listener: () => void): () => void;
  update(partial: Partial<T>): void;  // Triggers notification
}
```

**Web:**
```typescript
// Agent emits events to subscribers
agent.subscribe((event: AgentEvent) => {
  // React to state changes
});
```

---

### Unidirectional Data Flow (Both)

```
User Input → Agent.prompt() → Agent State Change → Event Emission → 
UI Subscription → Component Update → requestRender/requestUpdate() → Re-render
```

**TUI:** `Session.send()` → `AgentEvent` → `tui.requestRender()`  
**Web:** `agent.prompt()` → `AgentEvent` → `component.requestUpdate()`

---

### Component Composition (Both)

**TUI:**
```typescript
class Container implements Component {
  children: Component[] = [];
  
  render(width: number): string[] {
    return this.children.flatMap(child => child.render(width));
  }
}
```

**Web:**
```typescript
// Lit component composition
render() {
  return html`
    <message-list .messages=${this.messages}></message-list>
    <message-editor .onSend=${this.handleSend}></message-editor>
  `;
}
```

---

### Render Optimization

**TUI - Differential Rendering:**
- Line-level change detection
- Cursor movement optimization
- DEC 2026 synchronized output (flicker-free)

**Web - Strategic Component Splitting:**
- Stable message list (doesn't re-render during streaming)
- Separate streaming container (updates independently)
- Lit's efficient DOM diffing

---

## 5. Session Layer Abstraction

Both UIs depend on a **session abstraction** that encapsulates:

1. **State** - Model configuration, message history, streaming status
2. **Events** - Observable stream of agent activities
3. **Commands** - Methods to send input, change settings, abort

**TUI Session Interface:**
```typescript
interface Session {
  state: SessionState;
  send?(text: string): Promise<string>;
  setModel(id: string): void;
  subscribe(observer: (event: AgentEvent) => void): () => void;
}
```

**Web Agent Interface:**
```typescript
interface Agent {
  state: AgentState;
  prompt(input: string | AgentMessage): Promise<void>;
  abort(): void;
  subscribe(listener: (event: AgentEvent) => void): () => void;
}
```

**Implementation Layer:**

- **TUI** uses `AgentSession` (core/session) which wraps lower-level engine
- **Web** uses `Agent` (ui/web) which directly integrates with `@dpopsuev/alef-ai`

Both follow the same **observer pattern** where the session layer emits typed events that UI components subscribe to.

---

## 6. Tool Execution Flow

### TUI Tool Flow (Inferred)

```
Session.send("use calculator") 
  → Agent processes
  → Event: { type: 'tool-start', callId, name, args }
  → UI adds pending tool indicator
  → Tool executes (in engine/adapter layer)
  → Event: { type: 'tool-end', callId, ok, display }
  → UI shows tool result
```

### Web Tool Flow

```
Agent.prompt("create chart") 
  → Agent identifies tool call
  → Event: { type: 'tool_execution_start', toolCallId, toolName, args }
  → UI shows tool in progress
  → Tool.execute() runs
  → Event: { type: 'tool_execution_update', partialResult } (optional streaming)
  → Event: { type: 'tool_execution_end', result }
  → UI renders tool result via ToolRenderer
```

**Tool Renderer Pattern (Web):**

```typescript
// tools/renderer-registry.ts
const toolRenderers = new Map<string, ToolRenderer>();

interface ToolRenderer {
  render(params: any, result: any, isStreaming: boolean): {
    content: TemplateResult;
    isCustom: boolean;
  };
}

// Register custom renderer
registerToolRenderer('my_tool', {
  render: (params, result, isStreaming) => ({
    content: html`<div>Custom tool output</div>`,
    isCustom: false,
  }),
});
```

---

## 7. Strengths of the Architecture

### TUI Strengths

1. **Minimal Dependencies** - Self-contained, no framework lock-in
2. **Performance** - Differential rendering only updates changed lines
3. **Flicker-Free** - DEC 2026 synchronized output for atomic updates
4. **Component-Based** - Simple `Component` interface, easy to extend
5. **Reactive Stores** - Batched microtask notifications prevent render thrashing

### Web Strengths

1. **Declarative Templates** - Lit's HTML templates are readable and maintainable
2. **Type Safety** - TypeScript + decorators for reactive properties
3. **Render Splitting** - Separate stable/streaming containers for performance
4. **Storage Integration** - IndexedDB persistence built-in
5. **Tool Extensibility** - Registry pattern for custom tool renderers

---

## 8. Trade-offs & Design Decisions

### TUI

**Decision:** Manual differential rendering  
**Trade-off:** More complex rendering code, but **full control** over terminal output and **minimal overhead**

**Decision:** Observer pattern for state updates  
**Trade-off:** No automatic reactivity like Vue/Svelte, but **explicit** and **debuggable**

**Decision:** Component invalidation pattern  
**Trade-off:** Manual cache management, but **fine-grained control** over re-renders

### Web

**Decision:** Lit web components  
**Trade-off:** Framework dependency, but **standards-based** and **interoperable**

**Decision:** Split stable/streaming rendering  
**Trade-off:** More complex component tree, but **avoids re-rendering entire history** on every token

**Decision:** IndexedDB storage  
**Trade-off:** Async API complexity, but **persistent sessions** in browser

---

## 9. Conclusion

Both UI packages implement **clean reactive architectures** with:

1. **Clear separation** - State (Session/Agent) ↔ View (Components) ↔ Rendering (Differential/Lit)
2. **Observer pattern** - Session emits events → UI subscribes → Re-render
3. **Unidirectional flow** - User action → Agent → Event → UI update
4. **Component composition** - Small, focused components compose into complex UIs
5. **Render optimization** - TUI's differential rendering, Web's strategic splitting

The architecture is **extensible** (custom components, tool renderers), **testable** (pure render functions), and **performant** (batched updates, change detection).

**Key Insight:** Both UIs treat the session/agent layer as a **reactive data source** that emits events. The UI layer is purely **presentational** - it subscribes to events, updates local state, and requests re-renders. This creates a **clean contract** between layers that's easy to reason about and maintain.
