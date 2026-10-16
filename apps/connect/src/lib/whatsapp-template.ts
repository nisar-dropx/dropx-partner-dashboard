export type WhatsAppTemplateComponent = {
  type?: string;
  text?: string;
  format?: string;
  buttons?: Array<{ type?: string; text?: string; url?: string }>;
};

export type WhatsAppTemplateHeaderMediaType = "image" | "video" | "document";

export type WhatsAppTemplateVariable = {
  key: string;
  label: string;
  component: "header" | "body" | "button";
  position: number;
  buttonIndex?: number;
};

function placeholderPositions(text?: string) {
  const positions = new Set<number>();
  for (const match of (text ?? "").matchAll(/\{\{(\d+)\}\}/g)) positions.add(Number(match[1]));
  return Array.from(positions).sort((first, second) => first - second);
}

export function extractWhatsAppTemplateVariables(components: WhatsAppTemplateComponent[]) {
  const variables: WhatsAppTemplateVariable[] = [];
  components.forEach((component) => {
    const type = component.type?.toUpperCase();
    if (type === "HEADER" || type === "BODY") {
      const normalized = type.toLowerCase() as "header" | "body";
      placeholderPositions(component.text).forEach((position) => variables.push({
        key: `${normalized}.${position}`,
        label: `${type === "HEADER" ? "Header" : "Body"} variable ${position}`,
        component: normalized,
        position
      }));
    }

    if (type === "BUTTONS") {
      (component.buttons ?? []).forEach((button, buttonIndex) => {
        if (button.type?.toUpperCase() !== "URL") return;
        placeholderPositions(button.url).forEach((position) => variables.push({
          key: `button.${buttonIndex}.${position}`,
          label: `${button.text || "URL button"} variable ${position}`,
          component: "button",
          position,
          buttonIndex
        }));
      });
    }
  });
  return variables;
}

function mappedTemplateValue(source: string | undefined, values: Record<string, string>) {
  if (!source) return "";
  return values[source] ?? source;
}

export function buildConnectOtpTemplateComponents(
  components: WhatsAppTemplateComponent[],
  mappings: Record<string, string>,
  values: Record<string, string>
) {
  const variables = extractWhatsAppTemplateVariables(components);
  const messageComponents: Array<Record<string, unknown>> = [];
  for (const componentType of ["header", "body"] as const) {
    const componentVariables = variables
      .filter((variable) => variable.component === componentType)
      .sort((first, second) => first.position - second.position);
    if (!componentVariables.length) continue;
    messageComponents.push({
      type: componentType,
      parameters: componentVariables.map((variable) => ({
        type: "text",
        text: mappedTemplateValue(mappings[variable.key], values)
      }))
    });
  }
  for (const variable of variables.filter((item) => item.component === "button")) {
    messageComponents.push({
      type: "button",
      sub_type: "url",
      index: String(variable.buttonIndex ?? 0),
      parameters: [{ type: "text", text: mappedTemplateValue(mappings[variable.key], values) }]
    });
  }
  return messageComponents;
}

export function getWhatsAppTemplateHeaderMediaType(components: WhatsAppTemplateComponent[]): WhatsAppTemplateHeaderMediaType | null {
  const header = components.find((component) => component.type?.toUpperCase() === "HEADER");
  const format = header?.format?.toUpperCase();
  if (format === "IMAGE") return "image";
  if (format === "VIDEO") return "video";
  if (format === "DOCUMENT") return "document";
  return null;
}
