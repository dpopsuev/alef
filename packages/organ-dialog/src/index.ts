// Legacy discourse adapter — brownfield compat, not an organ
export type { DialogDiscoursePort } from "./legacy.js";
export { createDialogDiscoursePort } from "./legacy.js";
export { DIALOG_MESSAGE, DialogOrgan, type DialogOrganOptions, type MessageSink, makeMessageSense } from "./organ.js";
