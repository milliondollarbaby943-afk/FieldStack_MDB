/**
 * useProjectConnections — loads active sub companies connected to a GC project.
 */

import { useState, useEffect } from "react";
import {
  collection,
  onSnapshot,
  query,
  where,
  doc,
  getDoc,
} from "firebase/firestore";
import { firestore } from "@/lib/firebase";
import { useCompany } from "@/contexts/CompanyContext";
import type { ProjectConnection } from "@/types/fieldstack";

export interface ConnectedSub {
  id: string;
  name: string;
  connectionId: string;
}

export function useProjectConnections(projectId: string | undefined) {
  const { company } = useCompany();
  const [connectedSubs, setConnectedSubs] = useState<ConnectedSub[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!company || !projectId) {
      setConnectedSubs([]);
      setLoading(false);
      return;
    }

    const q = query(
      collection(firestore, `companies/${company.id}/projectConnections`),
      where("gcProjectId", "==", projectId),
      where("status", "==", "active")
    );

    const unsub = onSnapshot(q, async (snap) => {
      const connections = snap.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      })) as (ProjectConnection & { id: string })[];

      const subs = await Promise.all(
        connections.map(async (conn) => {
          const companySnap = await getDoc(
            doc(firestore, "companies", conn.subCompanyId)
          );
          const name = companySnap.exists()
            ? (companySnap.data().name as string)
            : conn.subCompanyId;
          return { id: conn.subCompanyId, name, connectionId: conn.id };
        })
      );

      setConnectedSubs(subs);
      setLoading(false);
    });

    return () => unsub();
  }, [company?.id, projectId]);

  return { connectedSubs, loading };
}
