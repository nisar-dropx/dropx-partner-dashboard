"use client";

export default function PageError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="page-loading" role="alert">
      <strong>This page could not be loaded</strong>
      <span>Something went wrong, or the database could not be reached. Please check your connection and try again.</span>
      <button className="button compact" onClick={() => reset()} type="button">Try again</button>
    </div>
  );
}
