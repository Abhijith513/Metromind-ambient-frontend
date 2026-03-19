import { AuthProvider, useAuth } from "./AuthContext";
import Login from "./Login";
import AudioCapture from "./AudioCapture";
import { auth } from "./firebase";
import { signOut } from "firebase/auth";

// The protected wrapper that adds a "Sign Out" button
function ProtectedRoute() {
  return (
    <div className="relative">
      <button 
        onClick={() => signOut(auth)}
        className="absolute top-4 right-6 z-50 text-[12px] font-[500] text-[#888] hover:text-[#111] transition-colors bg-white/50 px-3 py-1.5 rounded-md border border-[#e8e8e5] backdrop-blur-sm"
      >
        Sign Out
      </button>
      <AudioCapture />
    </div>
  );
}

// The Gatekeeper: Shows AudioCapture IF logged in, otherwise shows Login
function MainGatekeeper() {
  const { currentUser } = useAuth();
  return currentUser ? <ProtectedRoute /> : <Login />;
}

export default function App() {
  return (
    <AuthProvider>
      <MainGatekeeper />
    </AuthProvider>
  );
}