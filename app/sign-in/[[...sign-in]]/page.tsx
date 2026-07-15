import { ClerkFailed, ClerkLoaded, ClerkLoading, SignIn } from "@clerk/nextjs";
import { AuthCardFailed, AuthCardLoading } from "@/components/auth/auth-card-state";
import { AuthNavbar } from "@/components/auth/auth-navbar";

export default function SignInPage() {
  return (
    <main className="aurora isolate flex min-h-screen items-center justify-center overflow-hidden px-6 py-20">
      <AuthNavbar />
      <ClerkLoading>
        <AuthCardLoading />
      </ClerkLoading>
      <ClerkLoaded>
        <SignIn />
      </ClerkLoaded>
      <ClerkFailed>
        <AuthCardFailed />
      </ClerkFailed>
    </main>
  );
}
