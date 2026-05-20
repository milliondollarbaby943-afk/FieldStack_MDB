/**
 * CompanyContext — provides the active company and membership for the current user.
 *
 * Multi-tenant model:
 *   companies/{companyId}                  ← company document
 *   companies/{companyId}/members/{uid}    ← membership (role, name, email)
 *
 * A user can belong to multiple companies. For now we load the first one.
 * The active company is stored in localStorage so it persists across refreshes.
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  collection,
  doc,
  onSnapshot,
  query,
  where,
  getDocs,
  setDoc,
  serverTimestamp,
  Timestamp,
} from "firebase/firestore";
import { firestore } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import type { Company, CompanyMember, UserRole } from "@/types/fieldstack";

interface CompanyContextValue {
  company: Company | null;
  membership: CompanyMember | null;
  role: UserRole | null;
  loading: boolean;
  /** Switch the active company (for future multi-company support) */
  setActiveCompanyId: (id: string) => void;
}

const CompanyContext = createContext<CompanyContextValue | null>(null);

export function CompanyProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [company, setCompany] = useState<Company | null>(null);
  const [membership, setMembership] = useState<CompanyMember | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeCompanyId, setActiveCompanyId] = useState<string | null>(() =>
    localStorage.getItem("fieldstack_active_company")
  );

  useEffect(() => {
    if (!user) {
      setCompany(null);
      setMembership(null);
      setLoading(false);
      return;
    }

    setLoading(true);

    // Find all companies this user is a member of
    const membershipsQuery = query(
      collection(firestore, "companyMembers"),
      where("uid", "==", user.uid)
    );

    const unsub = onSnapshot(membershipsQuery, async (snap) => {
      if (snap.empty) {
        // User has no company yet — this is handled by onboarding
        setCompany(null);
        setMembership(null);
        setLoading(false);
        return;
      }

      // Pick the active company or default to the first one
      let targetMembership = snap.docs[0].data() as CompanyMember;
      if (activeCompanyId) {
        const found = snap.docs.find((d) => d.data().companyId === activeCompanyId);
        if (found) targetMembership = found.data() as CompanyMember;
      }

      setMembership(targetMembership);

      // Subscribe to the company document
      const companyRef = doc(firestore, "companies", targetMembership.companyId);
      const companyUnsub = onSnapshot(companyRef, (companySnap) => {
        if (companySnap.exists()) {
          setCompany({ id: companySnap.id, ...companySnap.data() } as Company);
        }
        setLoading(false);
      });

      return () => companyUnsub();
    });

    return () => unsub();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, activeCompanyId]);

  const handleSetActiveCompanyId = (id: string) => {
    localStorage.setItem("fieldstack_active_company", id);
    setActiveCompanyId(id);
  };

  return (
    <CompanyContext.Provider
      value={{
        company,
        membership,
        role: membership?.role ?? null,
        loading,
        setActiveCompanyId: handleSetActiveCompanyId,
      }}
    >
      {children}
    </CompanyContext.Provider>
  );
}

export function useCompany() {
  const ctx = useContext(CompanyContext);
  if (!ctx) throw new Error("useCompany must be used within CompanyProvider");
  return ctx;
}

// ─── Helper: create a new company + membership ────────────────────────────────

export async function createCompanyWithMember(params: {
  uid: string;
  email: string;
  name: string;
  companyName: string;
  companySlug: string;
  companyType?: "GC" | "SUB";
}): Promise<string> {
  const companyRef = doc(collection(firestore, "companies"));
  const companyId = companyRef.id;

  const now = serverTimestamp();

  await setDoc(companyRef, {
    id: companyId,
    name: params.companyName,
    slug: params.companySlug,
    companyType: params.companyType ?? "GC",
    plan: "FREE",
    stripeCustomerId: null,
    stripeSubId: null,
    trialEndsAt: null,
    createdAt: now,
    updatedAt: now,
  });

  // Create membership in flat collection for easy querying
  const memberRef = doc(firestore, "companyMembers", `${companyId}_${params.uid}`);
  await setDoc(memberRef, {
    uid: params.uid,
    companyId,
    role: "ADMIN" as UserRole,
    name: params.name,
    email: params.email,
    joinedAt: now,
  });

  // Seed default lead times
  const defaults = [
    { itemType: "CABINETS_STANDARD", label: "Standard Stock", leadTimeWeeks: 8 },
    { itemType: "CABINETS_CUSTOM", label: "Custom/Semi-Custom", leadTimeWeeks: 16 },
    { itemType: "COUNTERTOPS", label: "Fabricated", leadTimeWeeks: 3 },
    { itemType: "HARDWARE", label: "Standard", leadTimeWeeks: 4 },
  ];

  for (const lt of defaults) {
    const ltRef = doc(collection(firestore, "companies", companyId, "leadTimeSettings"));
    await setDoc(ltRef, {
      id: ltRef.id,
      companyId,
      itemType: lt.itemType,
      label: lt.label,
      leadTimeWeeks: lt.leadTimeWeeks,
      isDefault: true,
      projectId: null,
      createdAt: now,
    });
  }

  return companyId;
}
