import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { requirePagePermission } from "@/lib/authorization";
import { AdvertisingMaster } from "./workspace";
export const dynamic="force-dynamic";
export default async function Page(){await requirePagePermission("cps_inputs","access");return <AppShell active="Advertising Master" pageCode="cps_inputs"><PageHead title="Advertising Master" subtitle="Actual Meta expenses, station mappings and daily refresh coverage."/><AdvertisingMaster/></AppShell>;}
