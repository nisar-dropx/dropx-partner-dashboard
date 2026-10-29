"use server";
import {redirect} from "next/navigation";
export async function approveAdvanceRequest(_form:FormData) {redirect("https://one.dropxlogistics.com/approvals?section=pay-advances");}
export async function rejectAdvanceRequest(_form:FormData) {redirect("https://one.dropxlogistics.com/approvals?section=pay-advances");}
