// ============================================================================
// STYLESHEET PREPROCESSING TOGGLE
// ============================================================================

async function initializePreprocessingToggle() {
  const toggle = document.getElementById('preprocess-stylesheets') as HTMLInputElement;
  const status = document.getElementById('preprocess-status');

  if (!toggle || !status) {
    console.warn('[PREPROCESS] Toggle elements not found');
    return;
  }

  // Load saved preference
  const result = await chrome.storage.local.get(['preprocessStylesheets']);
  const enabled = result.preprocessStylesheets !== false; // Default true
  toggle.checked = enabled;

  // Check server status
  const checkServerStatus = async () => {
    try {
      const response = await fetch('http://localhost:4411/api/health', {
        signal: AbortSignal.timeout(3000)
      });

      if (response.ok) {
        status.className = 'preprocess-status server-online';
        status.textContent = 'Server online - preprocessing available';
        return true;
      }
    } catch (error) {
      // Server offline or unreachable
    }

    status.className = 'preprocess-status server-offline';
    status.textContent = 'Server offline - preprocessing unavailable';
    return false;
  };

  // Initial status check
  await checkServerStatus();

  // Update status every 10 seconds
  setInterval(checkServerStatus, 10000);

  // Handle toggle changes
  toggle.addEventListener('change', async () => {
    const enabled = toggle.checked;
    await chrome.storage.local.set({ preprocessStylesheets: enabled });
    console.log(`[PREPROCESS] Preprocessing ${enabled ? 'enabled' : 'disabled'}`);

    // Show immediate feedback
    if (enabled) {
      await checkServerStatus();
    }
  });
}

// Initialize immediately if DOM is already loaded
if (document.readyState !== 'loading') {
  void initializePreprocessingToggle();
} else {
  document.addEventListener('DOMContentLoaded', () => {
    void initializePreprocessingToggle();
  });
}

export { initializePreprocessingToggle };
