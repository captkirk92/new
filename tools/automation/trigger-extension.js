/**
 * Extension Automation Bridge
 *
 * Add this to your injected-script.ts to enable automation:
 *
 * // Listen for automation triggers
 * window.addEventListener('message', (event) => {
 *   if (event.data.type === 'TRIGGER_CAPTURE' && event.data.source === 'automation') {
 *     // Trigger your existing capture logic
 *     startCapture();
 *   }
 * });
 *
 * // Or expose a direct trigger
 * window.__FIGMA_CAPTURE_TRIGGER = () => {
 *   startCapture();
 * };
 */

console.log('Extension automation bridge loaded');
