import { SignIn } from "@clerk/nextjs";
import { AuthNavbar } from "@/components/auth/auth-navbar";
import { GridBackground } from "@/components/landing/grid-background";

export default function SignInPage() {
  return (
    <main className="aurora isolate flex min-h-screen items-center justify-center overflow-hidden px-6 py-20">
      <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
        <GridBackground ripples={false} />
      </div>
      <AuthNavbar />
      <SignIn />
    </main>
  );
}
