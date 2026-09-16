import { createFileRoute } from "@tanstack/react-router";
import { DiaryPage } from "@/components/lover/diary-page";

export const Route = createFileRoute("/diary")({ component: DiaryPage });
