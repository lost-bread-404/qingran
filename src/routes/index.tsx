import { createFileRoute } from "@tanstack/react-router";
import { VoiceRoom } from "@/components/lover/voice-room";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <VoiceRoom />;
}
