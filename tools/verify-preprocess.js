async function verify() {
  const serverUrl = "http://localhost:4411/api/preprocess";
  // A data URI for an HTML page that links to a data URI stylesheet
  // HTML: <html><head><link rel="stylesheet" href="data:text/css;charset=utf-8,body{color:red}"></head><body>Tested</body></html>
  // We double encode the inner data URI components to ensuring mostly safe transport
  const targetUrl =
    "data:text/html;charset=utf-8,%3Chtml%3E%3Chead%3E%3Clink%20rel%3D%22stylesheet%22%20href%3D%22data%3Atext%2Fcss%3Bcharset%3Dutf-8%2Cbody%257Bcolor%253Ared%257D%22%3E%3C%2Fhead%3E%3Cbody%3ETested%3C%2Fbody%3E%3C%2Fhtml%3E";

  try {
    console.log("Sending request to", serverUrl);
    const response = await fetch(serverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: targetUrl }),
    });

    if (!response.ok) {
      console.error(
        "Server returned error:",
        response.status,
        response.statusText,
      );
      const text = await response.text();
      console.error("Response body:", text);
      process.exit(1);
    }

    const data = await response.json();
    console.log("Response:", JSON.stringify(data, null, 2));

    if (data.ok && data.stats.errors.length === 0) {
      console.log("✅ Verification PASSED: No errors in preprocessing.");
    } else {
      console.error("❌ Verification FAILED: Errors found or ok is false.");
      process.exit(1);
    }
  } catch (err) {
    console.error("❌ Verification FAILED: Request failed", err);
    process.exit(1);
  }
}

verify();
