"use client";

import { useCallback, useRef, useState } from "react";

/**
 * React 18 / Next 14 equivalent of useFormState.
 * Production ships react-dom 18.3.1 (no React 19 useActionState).
 */
export function useCodFormState<S>(
  action: (state: S, formData: FormData) => Promise<S>,
  initialState: S
): [S, (formData: FormData) => Promise<void>] {
  const [state, setState] = useState(initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const formAction = useCallback(async (formData: FormData) => {
    const next = await action(stateRef.current, formData);
    setState(next);
  }, [action]);

  return [state, formAction];
}
