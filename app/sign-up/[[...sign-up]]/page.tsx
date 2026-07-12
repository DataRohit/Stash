import { SignUp } from "@clerk/nextjs";
import { AuthNavbar } from "@/components/auth/auth-navbar";

export default function SignUpPage() {
  return (
    <main className="aurora isolate flex min-h-screen items-center justify-center overflow-hidden px-6 py-20">
      <AuthNavbar />
      <SignUp />
    </main>
  );
}
