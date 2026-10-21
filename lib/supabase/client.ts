import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return document.cookie
            .split("; ")
            .filter(Boolean)
            .map((cookie) => {
              const [name, ...rest] = cookie.split("=");
              return { name, value: rest.join("=") };
            });
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            // Ensure cookies are set with proper attributes for PKCE flow
            const cookieOptions = {
              path: "/",
              sameSite: "lax" as const,
              secure: window.location.protocol === "https:",
              ...options,
            };
            
            let cookie = `${name}=${value}`;
            if (cookieOptions.path) cookie += `; path=${cookieOptions.path}`;
            if (cookieOptions.sameSite) cookie += `; samesite=${cookieOptions.sameSite}`;
            if (cookieOptions.secure) cookie += "; secure";
            if (cookieOptions.maxAge !== undefined) cookie += `; max-age=${cookieOptions.maxAge}`;
            if (cookieOptions.domain) cookie += `; domain=${cookieOptions.domain}`;
            
            document.cookie = cookie;
          });
        },
      },
    }
  );
}
