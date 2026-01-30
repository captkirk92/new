/**
 * StatusOverlay - DISABLED
 *
 * Progress is shown in the popup window, not as an overlay on the page.
 * All methods are no-ops to maintain compatibility with existing callers.
 */
export class StatusOverlay {
  show(_message: string, _phase?: string, _percent?: number): void {
    // No-op - progress shown in popup instead
  }

  update(
    _message: string,
    _phase?: string,
    _percent?: number,
    _details?: string
  ): void {
    // No-op - progress shown in popup instead
  }

  hide(): void {
    // No-op - progress shown in popup instead
  }
}
