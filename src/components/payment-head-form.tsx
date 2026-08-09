"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { SearchableSelectOption } from "@/components/searchable-select";
import { SubmitButton } from "@/components/submit-button";
import { DEFAULT_PAYMENT_FILE_GROUPS, PAYMENT_FILE_GROUPS, normalizePaymentFileGroups } from "@/lib/payment-file-types";
import { ALL_PAYMENT_MODES, PAYMENT_MODES, type PaymentMode } from "@/lib/payment-modes";

type Question = {
  id?: string | null;
  question_text: string;
  answer_type: string;
  dropdown_options?: string | null;
  allowed_file_types?: string[] | null;
  date_rule?: string | null;
  date_days?: number | null;
  is_required: boolean;
  field_stage?: FieldStage | null;
};

type FieldStage = "expense" | "payment";

type PaymentHeadFormProps = {
  action: (formData: FormData) => void;
  initialHead?: {
    id: string;
    code: string;
    name: string;
    external_id: string | null;
    initial_approval_role_id?: string | null;
    initial_approval_role_ids?: string[] | null;
    final_approval_role_id?: string | null;
    final_approval_role_ids?: string[] | null;
    payment_process_role_ids?: string[] | null;
    supported_payment_modes?: PaymentMode[] | null;
    requires_supporting_document: boolean;
    request_expense_approval: boolean;
    expense_approval_threshold?: number | null;
    is_active: boolean;
    questions: Question[];
  } | null;
  submitLabel?: string;
  roleOptions?: SearchableSelectOption[];
};

const answerTypes = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "dropdown", label: "Dropdown" },
  { value: "textarea", label: "Long text" },
  { value: "yes_no", label: "Yes / No" },
  { value: "file", label: "File Upload" }
];

function normalizeFieldStage(value?: string | null): FieldStage {
  return value === "payment" ? "payment" : "expense";
}

function emptyQuestion(fieldStage: FieldStage = "expense"): Question {
  return {
    question_text: "",
    answer_type: "text",
    dropdown_options: "",
    allowed_file_types: [...DEFAULT_PAYMENT_FILE_GROUPS],
    is_required: true,
    field_stage: fieldStage,
    date_rule: "any",
    date_days: null,
  };
}

function PaymentModeMultiSelect({ selectedValues }: { selectedValues?: PaymentMode[] | null }) {
  const [selected, setSelected] = useState<PaymentMode[]>(selectedValues?.length ? selectedValues : [...ALL_PAYMENT_MODES]);
  const [open, setOpen] = useState(false);

  function toggle(value: PaymentMode) {
    setSelected((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  }

  return (
    <div className="multi-select payment-role-multi-select">
      <input name="supported_payment_modes" type="hidden" value={JSON.stringify(selected)} />
      <button className={`multi-select-trigger ${open ? "open" : ""}`} onClick={() => setOpen((current) => !current)} type="button">
        {selected.length ? (
          <span className="payment-role-selected-tags">
            {PAYMENT_MODES.filter((option) => selected.includes(option.value)).map((option) => (
              <strong className="payment-role-selected-tag" key={option.value}>{option.label}</strong>
            ))}
          </span>
        ) : <span>Select supported methods</span>}
        <span>v</span>
      </button>
      {open ? (
        <div className="multi-select-menu">
          <div className="multi-select-options">
            {PAYMENT_MODES.map((option) => (
              <label className="multi-select-option payment-role-option" key={option.value}>
                <input checked={selected.includes(option.value)} onChange={() => toggle(option.value)} type="checkbox" />
                <span className="payment-role-option-copy"><strong>{option.label}</strong></span>
              </label>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function initialQuestionsWithStages(questions?: Question[] | null): Question[] {
  const normalized: Question[] = questions?.length
    ? questions.map((question) => ({
        ...question,
        allowed_file_types: normalizePaymentFileGroups(question.allowed_file_types ?? question.dropdown_options),
        field_stage: normalizeFieldStage(question.field_stage),
      }))
    : [];
  if (!normalized.some((question) => normalizeFieldStage(question.field_stage) === "expense")) {
    normalized.push(emptyQuestion("expense"));
  }
  if (!normalized.some((question) => normalizeFieldStage(question.field_stage) === "payment")) {
    normalized.push(emptyQuestion("payment"));
  }
  return normalized;
}

function dropdownOptionList(value?: string | null) {
  return String(value ?? "")
    .split(",")
    .map((option) => option.trim())
    .filter(Boolean);
}

function joinDropdownOptions(options: string[]) {
  return options.map((option) => option.trim()).filter(Boolean).join(", ");
}

function DropdownOptionTags({
  name,
  options,
  onChange
}: {
  name: string;
  options?: string | null;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const optionList = dropdownOptionList(options);

  function addOptions(value: string) {
    const existing = new Set(optionList.map((option) => option.toLowerCase()));
    const nextOptions = value
      .split(",")
      .map((option) => option.trim())
      .filter((option) => {
        if (!option) return false;
        const key = option.toLowerCase();
        if (existing.has(key)) return false;
        existing.add(key);
        return true;
      });
    if (!nextOptions.length) return;
    onChange(joinDropdownOptions([...optionList, ...nextOptions]));
  }

  function removeOption(index: number, event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    onChange(joinDropdownOptions(optionList.filter((_, optionIndex) => optionIndex !== index)));
  }

  return (
    <div className="dropdown-option-editor">
      <input name={name} type="hidden" value={joinDropdownOptions(optionList)} />
      <div className="dropdown-option-tags">
        {optionList.map((option, index) => (
          <span className="dropdown-option-tag" key={`${option}-${index}`}>
            {option}
            <button aria-label={`Remove ${option}`} onClick={(event) => removeOption(index, event)} type="button">x</button>
          </span>
        ))}
        <input
          className="dropdown-option-input"
          onBlur={() => {
            addOptions(draft);
            setDraft("");
          }}
          onChange={(event) => {
            const value = event.target.value;
            if (value.includes(",")) {
              addOptions(value);
              setDraft("");
              return;
            }
            setDraft(value);
          }}
          placeholder={optionList.length ? "Add option," : "Type option and comma"}
          value={draft}
        />
      </div>
    </div>
  );
}

function RoleMultiSelect({
  name,
  options,
  placeholder,
  selectedValues
}: {
  name: string;
  options: SearchableSelectOption[];
  placeholder: string;
  selectedValues?: string[] | null;
}) {
  const [selected, setSelected] = useState(selectedValues ?? []);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedValuesKey = (selectedValues ?? []).join("|");
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const selectedOptions = options.filter((option) => selectedSet.has(option.value));
  const filteredOptions = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return options;
    return options.filter((option) => `${option.label} ${option.helper ?? ""}`.toLowerCase().includes(term));
  }, [options, query]);

  useEffect(() => {
    setSelected(selectedValues ?? []);
    // selectedValues is often passed as a fresh [] on parent re-render. Key it by
    // content so typing in custom fields does not clear manually selected roles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedValuesKey]);

  useEffect(() => {
    function close(event: globalThis.MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  function toggle(value: string) {
    setSelected((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  }

  function removeSelected(value: string, event: MouseEvent<HTMLSpanElement>) {
    event.preventDefault();
    event.stopPropagation();
    setSelected((current) => current.filter((item) => item !== value));
  }

  return (
    <div className="multi-select payment-role-multi-select" ref={rootRef}>
      <input name={name} type="hidden" value={JSON.stringify(selected)} />
      <button className={`multi-select-trigger ${open ? "open" : ""}`} onClick={() => setOpen((current) => !current)} type="button">
        {selectedOptions.length ? (
          <span className="payment-role-selected-tags">
            {selectedOptions.map((option) => (
              <strong className="payment-role-selected-tag" key={option.value}>
                <span>{option.label}</span>
                <span
                  aria-label={`Remove ${option.label}`}
                  className="payment-role-selected-remove"
                  onClick={(event) => removeSelected(option.value, event)}
                  role="button"
                  tabIndex={0}
                >
                  x
                </span>
              </strong>
            ))}
          </span>
        ) : (
          <span>{placeholder}</span>
        )}
        <span>v</span>
      </button>
      {open ? (
        <div className="multi-select-menu">
          <div className="multi-select-search">
            <input className="field multi-select-search-field" onChange={(event) => setQuery(event.target.value)} placeholder="Search role" value={query} />
          </div>
          <div className="multi-select-options">
            {filteredOptions.map((option) => (
              <label className="multi-select-option payment-role-option" key={option.value}>
                <input checked={selected.includes(option.value)} onChange={() => toggle(option.value)} type="checkbox" />
                <span className="payment-role-option-copy">
                  <strong>{option.label}</strong>
                  {option.helper ? <small>{option.helper}</small> : null}
                </span>
              </label>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function PaymentHeadForm({ action, initialHead, roleOptions = [], submitLabel = "Save payment head" }: PaymentHeadFormProps) {
  const [questions, setQuestions] = useState<Question[]>(() => initialQuestionsWithStages(initialHead?.questions));
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [requestExpenseApproval, setRequestExpenseApproval] = useState(initialHead?.request_expense_approval ?? false);

  function updateQuestion(index: number, patch: Partial<Question>) {
    setQuestions((current) => current.map((question, questionIndex) => questionIndex === index ? { ...question, ...patch } : question));
  }

  function addQuestion(fieldStage: FieldStage) {
    setQuestions((current) => [...current, emptyQuestion(fieldStage)]);
  }

  function removeQuestion(index: number) {
    setQuestions((current) => current.filter((_, questionIndex) => questionIndex !== index));
  }

  function moveQuestion(fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex) return;
    setQuestions((current) => {
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }

  function renderQuestionList(fieldStage: FieldStage, title: string, description: string, addLabel: string) {
    const stagedQuestions = questions
      .map((question, index) => ({ question, index }))
      .filter(({ question }) => normalizeFieldStage(question.field_stage) === fieldStage);

    return (
      <>
        <div className="panel-head compact-head">
          <div>
            <h3>{title}</h3>
            <p className="subtle">{description}</p>
          </div>
        </div>
        <div className="question-list">
          {stagedQuestions.map(({ question, index }, stagedIndex) => (
            <div
              className={`form-grid four question-row payment-question-row ${draggingIndex === index ? "dragging" : ""}`}
              key={question.id ?? `new-${index}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (draggingIndex !== null) moveQuestion(draggingIndex, index);
                setDraggingIndex(null);
              }}
            >
              {question.id ? <input type="hidden" name={`questions[${index}][id]`} value={question.id} /> : null}
              <input type="hidden" name={`questions[${index}][field_stage]`} value={fieldStage} />
              <button
                aria-label="Drag to reorder field"
                className="question-drag-handle"
                draggable
                onDragEnd={() => setDraggingIndex(null)}
                onDragStart={(event) => {
                  setDraggingIndex(index);
                  event.dataTransfer.effectAllowed = "move";
                }}
                title="Drag to reorder"
                type="button"
              >
                ::
              </button>
              <label className="span-2">
                Field Name
                <input
                  className="field"
                  name={`questions[${index}][question_text]`}
                  onChange={(event) => updateQuestion(index, { question_text: event.target.value })}
                  placeholder="Example: Bill number"
                  value={question.question_text}
                />
              </label>
              <label>
                Field Type
                <select
                  className="field"
                  name={`questions[${index}][answer_type]`}
                  onChange={(event) => updateQuestion(index, {
                    answer_type: event.target.value,
                    allowed_file_types: event.target.value === "file"
                      ? normalizePaymentFileGroups(question.allowed_file_types)
                      : question.allowed_file_types,
                  })}
                  value={question.answer_type}
                >
                  {answerTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                </select>
              </label>
              <div className="question-row-actions">
                <label className="check-row">
                  <input
                    checked={question.is_required}
                    name={`questions[${index}][is_required]`}
                    onChange={(event) => updateQuestion(index, { is_required: event.target.checked })}
                    type="checkbox"
                    value="yes"
                  />
                  <span>Required</span>
                </label>
                {stagedQuestions.length > 1 ? (
                  <button className="question-remove-button" onClick={() => removeQuestion(index)} type="button" aria-label="Remove field">x</button>
                ) : null}
                {stagedIndex === stagedQuestions.length - 1 ? (
                  <button className="question-add-button question-add-button-inline" onClick={() => addQuestion(fieldStage)} type="button">{addLabel}</button>
                ) : null}
              </div>
              {question.answer_type === "dropdown" ? (
                <div className="span-4 form-field-block">
                  <span className="field-label">Dropdown Options</span>
                  <DropdownOptionTags
                    name={`questions[${index}][dropdown_options]`}
                    onChange={(value) => updateQuestion(index, { dropdown_options: value })}
                    options={question.dropdown_options}
                  />
                </div>
              ) : (
                <input type="hidden" name={`questions[${index}][dropdown_options]`} value={question.dropdown_options ?? ""} />
              )}
              {question.answer_type === "date" ? (
                <div className="span-4 form-grid two">
                  <label>
                    Allowed dates
                    <select
                      className="field"
                      name={`questions[${index}][date_rule]`}
                      onChange={(event) => updateQuestion(index, { date_rule: event.target.value })}
                      value={question.date_rule ?? "any"}
                    >
                      <option value="any">Any date</option>
                      <option value="today">Current date only</option>
                      <option value="past">Past dates only</option>
                      <option value="future">Future dates only</option>
                    </select>
                  </label>
                  {question.date_rule === "past" || question.date_rule === "future" ? (
                    <label>
                      Maximum number of days
                      <input
                        className="field"
                        min="1"
                        name={`questions[${index}][date_days]`}
                        onChange={(event) => updateQuestion(index, { date_days: Number(event.target.value) || null })}
                        placeholder="Example: 30"
                        required
                        step="1"
                        type="number"
                        value={question.date_days ?? ""}
                      />
                    </label>
                  ) : <input name={`questions[${index}][date_days]`} type="hidden" value="" />}
                </div>
              ) : (
                <>
                  <input name={`questions[${index}][date_rule]`} type="hidden" value="any" />
                  <input name={`questions[${index}][date_days]`} type="hidden" value="" />
                </>
              )}
              {question.answer_type === "file" ? (
                <div className="span-4 form-field-block">
                  <span className="field-label">Supported files</span>
                  <div className="question-file-type-options">
                    {PAYMENT_FILE_GROUPS.map((group) => {
                      const selected = normalizePaymentFileGroups(question.allowed_file_types);
                      return (
                        <label className="check-row" key={group.value}>
                          <input
                            checked={selected.includes(group.value)}
                            name={`questions[${index}][allowed_file_types]`}
                            onChange={(event) => {
                              const next = event.target.checked
                                ? [...selected, group.value]
                                : selected.filter((value) => value !== group.value);
                              updateQuestion(index, { allowed_file_types: next });
                            }}
                            type="checkbox"
                            value={group.value}
                          />
                          <span>{group.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </>
    );
  }

  return (
    <form action={action} className="panel-body">
      {initialHead?.id ? <input type="hidden" name="id" value={initialHead.id} /> : null}
      <div className="form-grid three">
        <label>
          Payment Head Code
          <input className="field uppercase-input" name="code" defaultValue={initialHead?.code ?? ""} placeholder="FUEL_ADVANCE" required />
        </label>
        <label>
          Payment Head Name
          <input className="field" name="name" defaultValue={initialHead?.name ?? ""} placeholder="Fuel advance" required />
        </label>
        <label>
          Payment Head External ID
          <input className="field" name="external_id" defaultValue={initialHead?.external_id ?? ""} placeholder="External accounting ID" />
        </label>
        <label>
          Initial Approver Role (Optional)
          <RoleMultiSelect
            name="initial_approval_role_ids"
            options={roleOptions}
            placeholder="Select initial roles (optional)"
            selectedValues={initialHead?.initial_approval_role_ids?.length ? initialHead.initial_approval_role_ids : (initialHead?.initial_approval_role_id ? [initialHead.initial_approval_role_id] : [])}
          />
        </label>
        <label>
          Final Approval User Role
          <RoleMultiSelect
            name="final_approval_role_ids"
            options={roleOptions}
            placeholder="Select final roles"
            selectedValues={initialHead?.final_approval_role_ids?.length ? initialHead.final_approval_role_ids : (initialHead?.final_approval_role_id ? [initialHead.final_approval_role_id] : [])}
          />
        </label>
        <label>
          Payment Process User Role
          <RoleMultiSelect
            name="payment_process_role_ids"
            options={roleOptions}
            placeholder="Select process roles"
            selectedValues={initialHead?.payment_process_role_ids ?? []}
          />
        </label>
        <label className="span-3">
          Supported Payment Methods
          <PaymentModeMultiSelect selectedValues={initialHead?.supported_payment_modes} />
          <span className="helper-text">Requesters can select only these methods.</span>
        </label>
        <label className="check-row payment-head-option">
          <input
            checked={requestExpenseApproval}
            name="request_expense_approval"
            onChange={(event) => setRequestExpenseApproval(event.target.checked)}
            type="checkbox"
            value="yes"
          />
          <span>Request Expense Approval</span>
        </label>
        {requestExpenseApproval ? (
          <label>
            Threshold Limit
            <input
              className="field"
              min="0"
              name="expense_approval_threshold"
              placeholder="Blank = all requests"
              step="0.01"
              type="number"
              defaultValue={initialHead?.expense_approval_threshold ?? ""}
            />
          </label>
        ) : null}
        {initialHead ? (
          <label>
            Status
            <select className="field" name="is_active" defaultValue={initialHead.is_active ? "true" : "false"}>
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </select>
          </label>
        ) : null}
      </div>

      <div className="section-divider" />
      <input type="hidden" name="question_count" value={questions.length} />
      {renderQuestionList("expense", "Expense request fields", "These fields appear in Expense Request before approval.", "+Add")}
      <div className="section-divider" />
      {renderQuestionList("payment", "Payment request fields", "These fields appear in Payment Requests and after expense approval when bank details are submitted.", "+Add")}

      <div className="form-actions">
        <SubmitButton>{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}
