export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} did not respond within ${ms}ms.`);
    this.name = "TimeoutError";
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label = "Request"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}
