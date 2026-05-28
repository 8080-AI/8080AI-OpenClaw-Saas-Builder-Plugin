const DEFAULT_SITE_URL = "https://8080.ai";

export type DesignShare = {
  share_id?: string;
  id?: string;
  share_url?: string;
};

export function buildDesignPreviewUrl(
  projectId: string,
  share: DesignShare | null | undefined,
  siteUrl = DEFAULT_SITE_URL
): string {
  const baseUrl = siteUrl.replace(/\/$/, "");
  const shareId = share?.share_id || share?.id;
  if (shareId) return `${baseUrl}/design/${projectId}/${shareId}`;
  return share?.share_url || `${baseUrl}/projects/${projectId}`;
}

export async function getDesignPreviewText(
  client: { createDesignShare(projectId: string): Promise<DesignShare> },
  projectId: string,
  siteUrl = DEFAULT_SITE_URL
): Promise<string> {
  try {
    const share = await client.createDesignShare(projectId);
    const url = buildDesignPreviewUrl(projectId, share, siteUrl);
    return `\n\nClick this URL to see the preview of design pages:\n${url}`;
  } catch {
    return "";
  }
}
