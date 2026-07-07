"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Anchor } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

const inputCls =
  "mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    const supabase = createClient();

    if (mode === "signin") {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) {
        setError(error.message);
        setBusy(false);
        return;
      }
      router.replace(searchParams.get("next") ?? "/");
      router.refresh();
    } else {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { full_name: fullName } },
      });
      if (error) {
        setError(error.message);
        setBusy(false);
        return;
      }
      if (data.session) {
        router.replace("/");
        router.refresh();
      } else {
        setNotice("Check your email to confirm your account, then sign in.");
        setMode("signin");
        setBusy(false);
      }
    }
  }

  return (
    <div className="flex min-h-screen">
      {/* Brand panel */}
      <div className="relative hidden flex-1 flex-col justify-between overflow-hidden bg-navy-950 p-12 lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.35]"
          style={{
            background:
              "radial-gradient(ellipse 90% 60% at 20% 110%, #1a63b8 0%, transparent 60%), radial-gradient(ellipse 60% 40% at 90% -10%, #1d4467 0%, transparent 55%)",
          }}
        />
        <div className="relative flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-white">
            <Anchor size={20} strokeWidth={2} />
          </span>
          <div className="leading-tight">
            <p className="text-base font-bold tracking-wide text-white">SMW</p>
            <p className="text-[0.7rem] font-medium uppercase tracking-[0.16em] text-white/50">
              Job Plans
            </p>
          </div>
        </div>
        <div className="relative max-w-md">
          <h2 className="text-3xl font-semibold leading-snug tracking-tight text-white">
            Estimate the job.
            <br />
            Route the approval.
            <br />
            <span className="text-white/55">Skip the spreadsheet.</span>
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-white/55">
            Project plans and job costing with a built-in approval workflow,
            connected to your QuickBooks customers and jobs.
          </p>
        </div>
        <p className="relative text-xs text-white/35">
          Superior Marine · internal tooling
        </p>
      </div>

      {/* Form panel */}
      <div className="flex flex-1 items-center justify-center bg-surface px-4">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex items-center gap-2.5 lg:hidden">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white">
              <Anchor size={18} strokeWidth={2} />
            </span>
            <p className="text-sm font-bold tracking-wide text-ink-900">
              SMW Job Plans
            </p>
          </div>

          <div className="rounded-2xl border border-line bg-white p-8 shadow-[0_1px_3px_rgba(13,36,56,0.08)]">
            <h1 className="text-lg font-semibold tracking-tight text-ink-900">
              {mode === "signin" ? "Welcome back" : "Create your account"}
            </h1>
            <p className="mt-1 text-sm text-ink-600">
              {mode === "signin"
                ? "Sign in to continue"
                : "The first account becomes the admin"}
            </p>

            <form onSubmit={handleSubmit} className="mt-6 space-y-4">
              {mode === "signup" && (
                <div>
                  <label className="block text-sm font-medium text-ink-900">
                    Full name
                  </label>
                  <input
                    type="text"
                    required
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    className={inputCls}
                  />
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-ink-900">
                  Email
                </label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-ink-900">
                  Password
                </label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputCls}
                />
              </div>

              {error && <p className="text-sm text-bad-600">{error}</p>}
              {notice && <p className="text-sm text-ok-600">{notice}</p>}

              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
              >
                {busy ? "Working…" : mode === "signin" ? "Sign in" : "Sign up"}
              </button>
            </form>
          </div>

          <button
            type="button"
            onClick={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setError(null);
            }}
            className="mt-4 text-sm text-ink-600 transition-colors hover:text-ink-900"
          >
            {mode === "signin"
              ? "New here? Create an account"
              : "Already have an account? Sign in"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
