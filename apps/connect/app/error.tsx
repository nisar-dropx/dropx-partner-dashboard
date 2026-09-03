"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="dx-friendly-error">
      <strong>Something went wrong</strong>
      <p>A technical error occurred. Please try again.</p>
      <button onClick={reset}>Try again</button>
    </main>
  );
}
