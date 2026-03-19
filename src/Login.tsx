import { useState } from "react";
import { auth } from "./firebase";
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile } from "firebase/auth";

export default function Login() {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  
  // New fields for Registration
  const [fullName, setFullName] = useState("");
  const [regId, setRegId] = useState("");
  
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      if (isLogin) {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        // Create the user
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;
        
        // Save Name to Firebase Profile
        await updateProfile(user, { displayName: fullName });
        
        // Save Reg ID locally, tied specifically to this user's unique ID
        localStorage.setItem(`regId_${user.uid}`, regId);
      }
    } catch (err: any) {
      setError(err.message || "Failed to authenticate.");
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-[#f4f7f6] flex items-center justify-center p-6 font-['DM_Sans']">
      <div className="w-full max-w-sm bg-white border border-[#e1e8e6] rounded-2xl shadow-lg shadow-[#179ea1]/5 p-8">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-[#179ea1] to-[#4bcba2] tracking-wider uppercase mb-1">
            Metro Mind
          </h1>
          <p className="text-[10px] font-[600] tracking-[0.2em] text-[#8aa39e] uppercase">
            Made For Minds
          </p>
          <div className="mt-4 text-[1.2rem] font-[500] text-[#33413e]">
            {isLogin ? "Clinician Portal" : "Register Account"}
          </div>
        </div>

        {error && <div className="mb-4 p-3 bg-red-50 text-red-600 text-xs rounded-lg border border-red-100">{error}</div>}

        <form onSubmit={handleSubmit} className="space-y-4">
          {!isLogin && (
            <>
              <div>
                <label className="block text-[11px] font-[600] text-[#718a85] uppercase tracking-wide mb-1.5">Full Name (with Title)</label>
                <input type="text" required value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Dr. John Doe" className="w-full px-3 py-2 border border-[#d3dedb] rounded-lg text-[14px] focus:outline-none focus:border-[#179ea1] focus:ring-1 focus:ring-[#179ea1] transition-all" />
              </div>
              <div>
                <label className="block text-[11px] font-[600] text-[#718a85] uppercase tracking-wide mb-1.5">Registration ID</label>
                <input type="text" required value={regId} onChange={(e) => setRegId(e.target.value)} placeholder="TCMC-12345" className="w-full px-3 py-2 border border-[#d3dedb] rounded-lg text-[14px] focus:outline-none focus:border-[#179ea1] focus:ring-1 focus:ring-[#179ea1] transition-all" />
              </div>
            </>
          )}
          
          <div>
            <label className="block text-[11px] font-[600] text-[#718a85] uppercase tracking-wide mb-1.5">Email</label>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-full px-3 py-2 border border-[#d3dedb] rounded-lg text-[14px] focus:outline-none focus:border-[#179ea1] focus:ring-1 focus:ring-[#179ea1] transition-all" />
          </div>
          <div>
            <label className="block text-[11px] font-[600] text-[#718a85] uppercase tracking-wide mb-1.5">Password</label>
            <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className="w-full px-3 py-2 border border-[#d3dedb] rounded-lg text-[14px] focus:outline-none focus:border-[#179ea1] focus:ring-1 focus:ring-[#179ea1] transition-all" />
          </div>
          
          <button disabled={loading} className="w-full bg-gradient-to-r from-[#179ea1] to-[#4bcba2] hover:from-[#14898c] hover:to-[#41af8c] text-white font-[600] text-[14px] py-2.5 rounded-lg mt-2 transition-all shadow-md shadow-[#179ea1]/20 disabled:opacity-50">
            {loading ? "Authenticating..." : isLogin ? "Sign In" : "Create Account"}
          </button>
        </form>

        <div className="mt-6 text-center">
          <button onClick={() => setIsLogin(!isLogin)} type="button" className="text-[12px] text-[#718a85] hover:text-[#179ea1] transition-colors">
            {isLogin ? "Need access? Create an account" : "Already have an account? Sign in"}
          </button>
        </div>
      </div>
    </div>
  );
}