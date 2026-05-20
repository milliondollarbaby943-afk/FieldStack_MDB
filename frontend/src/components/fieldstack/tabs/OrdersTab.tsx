/**
 * OrdersTab — order tracking with inline PO/status/vendor editing.
 */

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Pencil, Check, X } from "lucide-react";
import { toast } from "sonner";
import { Timestamp } from "firebase/firestore";
import { format } from "date-fns";
import { apiUpdateOrder } from "@/lib/fieldstackApi";
import type { Task, OrderItem, OrderStatus } from "@/types/fieldstack";
import { ITEM_TYPE_LABELS, ORDER_STATUS_LABELS } from "@/types/fieldstack";

const ORDER_STATUSES: OrderStatus[] = ["NOT_ORDERED", "ORDERED", "IN_TRANSIT", "DELIVERED", "CANCELLED"];

function statusVariant(s: OrderStatus): "destructive" | "secondary" | "outline" | "default" {
  if (s === "NOT_ORDERED") return "destructive";
  if (s === "ORDERED" || s === "IN_TRANSIT") return "secondary";
  if (s === "DELIVERED") return "outline";
  return "outline";
}

function fmt(ts: Timestamp | undefined | null) {
  if (!ts) return "—";
  return format(ts.toDate(), "MMM d, yyyy");
}

interface Props {
  tasks: Task[];
  orderItems: OrderItem[];
}

export function OrdersTab({ tasks, orderItems }: Props) {
  if (orderItems.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <div className="text-3xl mb-3 opacity-40">📦</div>
          <p className="text-sm text-muted-foreground">No order items yet. Upload a schedule to generate orders.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Order Tracker</h3>
        <span className="text-xs text-muted-foreground font-mono">{orderItems.length} items</span>
      </div>

      <div className="flex flex-col gap-2">
        {orderItems.map((item) => (
          <OrderRow key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}

function OrderRow({ item }: { item: OrderItem }) {
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<OrderStatus>(item.status);
  const [poNumber, setPoNumber] = useState(item.poNumber ?? "");
  const [vendor, setVendor] = useState(item.vendorName ?? "");
  const [notes, setNotes] = useState(item.notes ?? "");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await apiUpdateOrder(item.id, { status, poNumber: poNumber || undefined, vendorName: vendor || undefined, notes: notes || undefined });
      toast.success("Order updated.");
      setEditing(false);
    } catch {
      toast.error("Failed to update order.");
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setStatus(item.status);
    setPoNumber(item.poNumber ?? "");
    setVendor(item.vendorName ?? "");
    setNotes(item.notes ?? "");
    setEditing(false);
  }

  return (
    <Card>
      <CardContent className="py-3 px-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="text-sm font-medium">
                {item.itemType === "TRADE_MATERIALS" && item.taskName
                  ? item.taskName
                  : (ITEM_TYPE_LABELS[item.itemType] ?? item.itemType)}
              </span>
              {item.assignedResource && (
                <Badge variant="secondary" className="text-[10px]">{item.assignedResource}</Badge>
              )}
              {(item.building || item.floor) && (
                <span className="text-xs text-muted-foreground font-mono">
                  {[item.building, item.floor].filter(Boolean).join(" – ")}
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground font-mono flex gap-4 flex-wrap">
              <span>Order by: <span className="text-foreground">{fmt(item.orderByDate)}</span></span>
              <span>Lead time: {item.leadTimeWeeks}w</span>
              {item.poNumber && <span>PO: {item.poNumber}</span>}
              {item.vendorName && <span>Vendor: {item.vendorName}</span>}
            </div>
            {item.notes && !editing && (
              <div className="text-xs text-muted-foreground mt-1 italic">{item.notes}</div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!editing ? (
              <>
                <Badge variant={statusVariant(item.status)} className="text-xs">
                  {ORDER_STATUS_LABELS[item.status]}
                </Badge>
                <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setEditing(true)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </>
            ) : (
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-emerald-600" onClick={handleSave} disabled={saving}>
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                </Button>
                <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground" onClick={handleCancel} disabled={saving}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
        </div>

        {editing && (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Status</label>
              <Select value={status} onValueChange={(v) => setStatus(v as OrderStatus)}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ORDER_STATUSES.map((s) => (
                    <SelectItem key={s} value={s} className="text-xs">{ORDER_STATUS_LABELS[s]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">PO Number</label>
              <Input className="h-8 text-xs" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} placeholder="PO-12345" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Vendor</label>
              <Input className="h-8 text-xs" value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Vendor name" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Notes</label>
              <Input className="h-8 text-xs" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes" />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
