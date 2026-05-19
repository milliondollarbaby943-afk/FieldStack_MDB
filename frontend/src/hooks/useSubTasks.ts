/**
 * useSubTasks — real-time subscription to tasks assigned to the sub company.
 *
 * Uses collectionGroup("tasks") filtered by assignedSubCompanyId.
 * Also loads taskSteps per project so the sub can update step status/notes.
 */

import { useState, useEffect } from "react";
import {
  collectionGroup,
  collection,
  onSnapshot,
  query,
  where,
  getDoc,
  doc,
} from "firebase/firestore";
import { firestore } from "@/lib/firebase";
import { useCompany } from "@/contexts/CompanyContext";
import type { Task, TaskStep } from "@/types/fieldstack";

export interface SubProjectGroup {
  gcCompanyId: string;
  projectId: string;
  projectName: string;
  tasks: Task[];
  steps: TaskStep[];
}

export function useSubTasks() {
  const { company } = useCompany();
  const [groups, setGroups] = useState<SubProjectGroup[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!company) { setLoading(false); return; }

    const q = query(
      collectionGroup(firestore, "tasks"),
      where("assignedSubCompanyId", "==", company.id)
    );

    // Map from "gcCompanyId/projectId" → subscription unsub function
    const stepUnsubs = new Map<string, () => void>();
    // Accumulated state
    const tasksMap = new Map<string, Task[]>(); // key: "gcCompanyId/projectId"
    const stepsMap = new Map<string, TaskStep[]>(); // key: "gcCompanyId/projectId"
    const projectNames = new Map<string, string>(); // key: "gcCompanyId/projectId"

    function rebuildGroups() {
      const result: SubProjectGroup[] = [];
      for (const [key, tasks] of tasksMap) {
        const [gcCompanyId, projectId] = key.split("/");
        result.push({
          gcCompanyId,
          projectId,
          projectName: projectNames.get(key) ?? projectId,
          tasks,
          steps: stepsMap.get(key) ?? [],
        });
      }
      result.sort((a, b) => a.projectName.localeCompare(b.projectName));
      setGroups(result);
    }

    function subscribeToSteps(gcCompanyId: string, projectId: string, key: string) {
      if (stepUnsubs.has(key)) return;
      const stepsQuery = query(
        collection(firestore, `companies/${gcCompanyId}/projects/${projectId}/taskSteps`)
      );
      const unsub = onSnapshot(stepsQuery, (snap) => {
        stepsMap.set(key, snap.docs.map((d) => ({ id: d.id, ...d.data() })) as TaskStep[]);
        rebuildGroups();
      });
      stepUnsubs.set(key, unsub);
    }

    const taskUnsub = onSnapshot(q, async (snap) => {
      // Group tasks by project
      const grouped = new Map<string, Task[]>();
      for (const d of snap.docs) {
        const task = { id: d.id, ...d.data() } as Task;
        const gcCompanyId = task.companyId;
        const projectId = task.projectId;
        const key = `${gcCompanyId}/${projectId}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(task);
      }

      // Update tasks map; subscribe to steps for new projects
      const removedKeys = new Set(tasksMap.keys());
      for (const [key, tasks] of grouped) {
        tasksMap.set(key, tasks);
        removedKeys.delete(key);

        const [gcCompanyId, projectId] = key.split("/");

        // Fetch project name if we don't have it yet
        if (!projectNames.has(key)) {
          getDoc(doc(firestore, `companies/${gcCompanyId}/projects/${projectId}`))
            .then((snap) => {
              projectNames.set(key, (snap.data()?.name as string) ?? projectId);
              rebuildGroups();
            })
            .catch(() => {});
        }

        subscribeToSteps(gcCompanyId, projectId, key);
      }

      // Clean up removed projects
      for (const key of removedKeys) {
        tasksMap.delete(key);
        stepsMap.delete(key);
        stepUnsubs.get(key)?.();
        stepUnsubs.delete(key);
      }

      rebuildGroups();
      setLoading(false);
    }, () => { setLoading(false); });

    return () => {
      taskUnsub();
      for (const unsub of stepUnsubs.values()) unsub();
    };
  }, [company?.id]);

  return { groups, loading };
}
