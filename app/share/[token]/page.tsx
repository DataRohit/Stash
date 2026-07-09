import type { Metadata } from "next";
import { SharedDocumentView } from "@/app/share/[token]/shared-document-view";

export const metadata: Metadata = {
  title: "Shared document",
};

export default async function SharedDocumentPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <SharedDocumentView token={token} />;
}
