"use client";

// Replaces the root layout when it fails, so it cannot rely on globals.css being loaded.
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ alignItems: "center", display: "flex", flexDirection: "column", fontFamily: "system-ui, sans-serif", gap: 12, justifyContent: "center", minHeight: "100vh", padding: 24, textAlign: "center" }}>
        <strong>This page could not be loaded</strong>
        <span>Something went wrong, or the database could not be reached. Please check your connection and try again.</span>
        <button onClick={() => reset()} style={{ cursor: "pointer", padding: "8px 16px" }} type="button">Try again</button>
      </body>
    </html>
  );
}
