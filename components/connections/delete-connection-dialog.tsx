"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api } from "@/lib/api-client";

type DeleteConnectionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId?: string;
  connectionName?: string;
  connectionIds?: string[];
  onSuccess?: () => void;
};

export function DeleteConnectionDialog({
  open,
  onOpenChange,
  connectionId,
  connectionName,
  connectionIds,
  onSuccess,
}: DeleteConnectionDialogProps) {
  const [deleting, setDeleting] = useState(false);

  const isBulk = connectionIds && connectionIds.length > 0;
  const count = isBulk ? connectionIds.length : 1;

  const handleDelete = async () => {
    try {
      setDeleting(true);

      if (isBulk) {
        await api.appConnection.bulkDelete(connectionIds);
        toast.success(`Deleted ${count} connection${count > 1 ? "s" : ""}`);
      } else if (connectionId) {
        await api.appConnection.delete(connectionId);
        toast.success("Connection deleted");
      }

      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete"
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete {isBulk ? `${count} connections` : "connection"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isBulk
              ? `This will permanently delete ${count} selected connections. This action cannot be undone.`
              : `This will permanently delete "${connectionName}". Any workflows using this connection will no longer work.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={deleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {deleting ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
