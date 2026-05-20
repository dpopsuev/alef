// Trace module — log all unhandled rejections
process.on('unhandledRejection', (reason) => {
  console.error('[trace] unhandledRejection:', reason?.message ?? reason);
});
process.on('uncaughtException', (err) => {
  console.error('[trace] uncaughtException:', err.message);
});
