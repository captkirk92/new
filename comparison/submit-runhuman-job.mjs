#!/usr/bin/env node
/**
 * Submit a QA test job to RunHuman
 */

const RUNHUMAN_API_KEY = "qa_live_9e373cf31beaec8bed2dc803ee964d1951867f43";
const RUNHUMAN_BASE_URL = "https://runhuman.com";

async function submitJob() {
  console.log("🚀 Submitting job to RunHuman...\n");

  const jobPayload = {
    url: "https://many-pandas-lick.loca.lt",
    description: `## Web-to-Figma Fidelity Test

You will see a comparison page with TWO images:
- **LEFT (Green header)**: Original website screenshot
- **RIGHT (Orange header)**: Our Figma render output

### Your Task
1. Compare the two images side by side
2. Identify all visual differences
3. Rate the overall fidelity from 1-10 (10 = perfect match)

### Focus On:
- **Images**: Are all images rendered? Any grey/orange placeholder boxes?
- **Icons/Logos**: Are SVG icons and logos visible?
- **Layout**: Are elements positioned correctly?
- **Colors**: Do background and text colors match?
- **Hidden Elements**: Are any elements visible that should be hidden?

### Please Report:
- Overall fidelity score (1-10)
- Count of broken/missing images
- Description of layout issues
- Any other visual differences you notice`,
    outputSchema: {
      type: "object",
      properties: {
        fidelityScore: {
          type: "number",
          description: "Overall fidelity score from 1-10 (10 = perfect match)",
        },
        brokenImageCount: {
          type: "number",
          description:
            "Number of images that are missing or rendered as placeholder boxes",
        },
        imageIssues: {
          type: "string",
          description: "Description of image-related issues",
        },
        layoutIssues: {
          type: "string",
          description: "Description of layout/positioning issues",
        },
        colorIssues: {
          type: "string",
          description: "Description of color mismatch issues",
        },
        otherIssues: {
          type: "string",
          description: "Any other visual differences noticed",
        },
        summary: {
          type: "string",
          description: "Overall summary of findings",
        },
      },
      required: ["fidelityScore", "summary"],
    },
    targetDurationMinutes: 10,
    screenSize: "desktop",
  };

  try {
    const response = await fetch(`${RUNHUMAN_BASE_URL}/api/jobs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RUNHUMAN_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(jobPayload),
    });

    if (!response.ok) {
      const error = await response
        .json()
        .catch(() => ({ message: response.statusText }));
      throw new Error(`API error: ${error.message || response.statusText}`);
    }

    const result = await response.json();
    console.log("✅ Job submitted successfully!\n");
    console.log("Job ID:", result.jobId || result.id);
    console.log("Status:", result.status);
    console.log("\n📋 Job Details:");
    console.log(JSON.stringify(result, null, 2));

    return result;
  } catch (error) {
    console.error("❌ Failed to submit job:", error.message);
    process.exit(1);
  }
}

submitJob();
