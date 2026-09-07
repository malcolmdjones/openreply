import GoogleSignInButton from "@/components/google-sign-in-button";
import { getCampaignTemplate } from "@/lib/templates/campaign-templates";
import { DemoNotice } from "@/components/demo-notice";

export const metadata = {
  title: "Login - OpenReply",
  description: "Sign in to manage Instagram comment-to-DM campaigns.",
};

function loginErrorMessage(error: string | undefined): string | null {
  switch (error) {
    case "not_allowed":
      return "That Google account is not on the allowlist for this OpenReply instance.";
    case "exchange_failed":
    case "missing_code":
    case "oauth_error":
    case "user_sync_failed":
      return "Google sign-in failed. Please try again.";
    default:
      return error ? "Sign-in failed. Please try again." : null;
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    callbackUrl?: string;
    template?: string;
    error?: string;
  }>;
}) {
  const params = await searchParams;
  const selectedTemplate = getCampaignTemplate(params.template);
  const templateCallbackUrl = selectedTemplate
    ? `/campaigns/new?template=${selectedTemplate.slug}`
    : null;
  const callbackUrl = params.callbackUrl ?? templateCallbackUrl ?? "/dashboard";
  const errorMessage = loginErrorMessage(params.error);

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-foreground">OpenReply</h1>
          <p className="text-muted text-sm leading-relaxed mt-2">
            {selectedTemplate
              ? `Sign in to use the ${selectedTemplate.title} template.`
              : "Sign in with Google, then connect your Instagram professional account."}
          </p>
        </div>

        <DemoNotice variant="panel" />

        <div className="panel rounded p-8 shadow-black/40">
          {selectedTemplate && (
            <div className="mb-5 border border-accent/20 bg-accent/10 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-accent">
                Template selected
              </p>
              <p className="mt-2 text-sm font-semibold text-foreground">
                {selectedTemplate.title}
              </p>
            </div>
          )}

          {errorMessage ? (
            <div className="mb-5 border border-error/30 bg-error/10 p-4">
              <p className="text-sm text-error">{errorMessage}</p>
            </div>
          ) : null}

          <GoogleSignInButton callbackUrl={callbackUrl} />

          <p className="mt-6 text-center text-xs text-muted">
            Email magic-link sign-in is temporarily unavailable.
          </p>
        </div>
      </div>
    </div>
  );
}
