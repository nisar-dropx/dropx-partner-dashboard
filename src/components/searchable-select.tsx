"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";

export type SearchableSelectOption = {
  value: string;
  label: string;
  helper?: string;
};

type SearchableSelectProps = {
  name: string;
  options: SearchableSelectOption[];
  defaultValue?: string | null;
  value?: string | null;
  placeholder: string;
  required?: boolean;
  disabled?: boolean;
  onValueChange?: (value: string) => void;
};

export function SearchableSelect({ name, options, defaultValue, value: controlledValue, placeholder, required, disabled, onValueChange }: SearchableSelectProps) {
  const isControlled = controlledValue !== undefined;
  const initialValue = isControlled ? controlledValue ?? "" : defaultValue ?? "";
  const initialOption = options.find((option) => option.value === initialValue);
  const [value, setValue] = useState(initialValue);
  const [query, setQuery] = useState(initialOption?.label ?? "");
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef(initialValue);
  const queryRef = useRef(initialOption?.label ?? "");
  const defaultValueRef = useRef(defaultValue ?? "");
  const optionsRef = useRef(options);
  const disabledRef = useRef(disabled);
  const onValueChangeRef = useRef(onValueChange);

  const filteredOptions = useMemo(() => {
    const term = query.trim().toLowerCase();
    const selected = options.find((option) => option.value === value);
    const showingSelectedLabel = selected?.label.toLowerCase() === term;

    if (!term || showingSelectedLabel) return options.slice(0, 30);

    return options
      .filter((option) => `${option.label} ${option.helper ?? ""}`.toLowerCase().includes(term))
      .slice(0, 30);
  }, [options, query, value]);

  function choose(option: SearchableSelectOption) {
    if (disabledRef.current) return;
    const changed = option.value !== valueRef.current;
    valueRef.current = option.value;
    queryRef.current = option.label;
    setValue(option.value);
    setQuery(option.label);
    setOpen(false);
    if (changed) onValueChangeRef.current?.(option.value);
  }

  function clearSelection() {
    if (disabledRef.current) return;
    const changed = Boolean(valueRef.current);
    valueRef.current = "";
    queryRef.current = "";
    setValue("");
    setQuery("");
    setOpen(false);
    if (changed) onValueChangeRef.current?.("");
  }

  function syncExactMatch() {
    const queryValue = inputRef.current?.value ?? queryRef.current;
    const term = queryValue.trim().toLowerCase();
    const currentOptions = optionsRef.current;
    const match = currentOptions.find((option) => (
      option.label.toLowerCase() === term || (option.helper ?? "").toLowerCase() === term
    ));
    if (match) {
      choose(match);
      return;
    }

    if (!queryValue.trim()) {
      valueRef.current = "";
      queryRef.current = "";
      setValue("");
      setQuery("");
      onValueChangeRef.current?.("");
    } else {
      const selected = currentOptions.find((option) => option.value === valueRef.current);
      queryRef.current = selected?.label ?? "";
      setQuery(queryRef.current);
    }
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;

    function closeOnOutsideClick(event: MouseEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        syncExactMatch();
      }
    }

    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [open]);

  useEffect(() => {
    inputRef.current?.setCustomValidity(required && !value ? "Select an option from the list." : "");
  }, [required, value]);

  useEffect(() => {
    optionsRef.current = options;
    disabledRef.current = disabled;
    onValueChangeRef.current = onValueChange;
  }, [disabled, onValueChange, options]);

  useEffect(() => {
    if (isControlled) return;
    const nextDefaultValue = defaultValue ?? "";
    if (nextDefaultValue === defaultValueRef.current) return;

    defaultValueRef.current = nextDefaultValue;
    const selected = options.find((option) => option.value === nextDefaultValue);
    valueRef.current = nextDefaultValue;
    queryRef.current = selected?.label ?? "";
    setValue(nextDefaultValue);
    setQuery(selected?.label ?? "");
    setOpen(false);
  }, [defaultValue, isControlled, options]);

  useEffect(() => {
    if (!isControlled) return;

    const currentValue = controlledValue ?? "";
    const selected = options.find((option) => option.value === currentValue);
    if (value !== currentValue) {
      valueRef.current = currentValue;
      queryRef.current = selected?.label ?? "";
      setValue(currentValue);
      setQuery(selected?.label ?? "");
      return;
    }
    if (!open && query !== (selected?.label ?? "")) {
      queryRef.current = selected?.label ?? "";
      setQuery(selected?.label ?? "");
    }
  }, [controlledValue, isControlled, open, options, query, value]);

  return (
    <div className="searchable-select" ref={wrapperRef}>
      <input disabled={disabled} type="hidden" name={name} value={value} required={required} />
      <div className={`searchable-control ${open ? "open" : ""} ${disabled ? "disabled" : ""}`}>
        <input
          aria-required={required}
          autoComplete="off"
          className="searchable-input"
          disabled={disabled}
          onBlur={() => window.setTimeout(syncExactMatch, 180)}
          onChange={(event) => {
            const nextQuery = event.target.value;
            queryRef.current = nextQuery;
            setQuery(nextQuery);
            if (!nextQuery.trim()) {
              valueRef.current = "";
              setValue("");
              onValueChangeRef.current?.("");
            }
            setOpen(true);
          }}
          onFocus={() => !disabled && setOpen(true)}
          placeholder={placeholder}
          ref={inputRef}
          required={required}
          value={query}
        />
        {value && !disabled ? (
          <button
            aria-label="Clear selected option"
            className="searchable-clear"
            onMouseDown={(event) => event.preventDefault()}
            onClick={clearSelection}
            type="button"
          >
            <X aria-hidden="true" size={14} strokeWidth={2.4} />
          </button>
        ) : null}
        <button
          aria-label={open ? "Close options" : "Open options"}
          className="searchable-toggle"
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => !disabled && setOpen((current) => !current)}
          type="button"
        >
          <ChevronDown aria-hidden="true" size={16} strokeWidth={2.4} />
        </button>
      </div>
      {open ? (
        <div className="searchable-menu">
          {filteredOptions.length ? filteredOptions.map((option, index) => (
            <button
              className={`searchable-option ${option.value === value ? "selected" : ""}`}
              key={`${name}-${option.value || "blank"}-${option.label}-${index}`}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(option);
              }}
              onClick={() => choose(option)}
              type="button"
            >
              <span>{option.label}</span>
              {option.helper ? <small>{option.helper}</small> : null}
            </button>
          )) : (
            <div className="searchable-empty">No matches</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
