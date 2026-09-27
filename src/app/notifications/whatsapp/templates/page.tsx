import {AppShell} from "@/components/app-shell";
import {PageHead} from "@/components/page-head";
import {WhatsAppTemplateManager} from "@/components/whatsapp-template-manager";
import {loadTemplateLibrary} from "@/app/settings/whatsapp-template-actions";
export const dynamic="force-dynamic";
export default async function WhatsAppTemplatesPage(){
  const library=await loadTemplateLibrary();
  return <AppShell active="WhatsApp" pageCode="app_settings">
    <PageHead eyebrow="WhatsApp" title="Message templates" subtitle="Create once. Get Meta approval. Reuse for your next message."/>
    <WhatsAppTemplateManager {...library} sendPath="/notifications/whatsapp"/>
  </AppShell>;
}

