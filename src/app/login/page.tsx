import LoginForm from "@/components/LoginForm";

export default function LoginPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center bg-zinc-950 px-4 py-10 text-zinc-100">
      <div className="flex w-full max-w-sm flex-col items-center gap-8">
        <header className="flex flex-col items-center gap-3 text-center">
          <h1 className="text-sm font-semibold uppercase tracking-[0.4em] text-zinc-500">
            Polarito
          </h1>
          <p className="text-2xl font-black uppercase tracking-tight text-white">
            Sign in required
          </p>
          <p className="text-sm leading-relaxed text-slate-300">
            Enter the credentials from your local or host environment. The dashboard stays locked
            until the server accepts them.
          </p>
        </header>
        <LoginForm />
      </div>
    </main>
  );
}
