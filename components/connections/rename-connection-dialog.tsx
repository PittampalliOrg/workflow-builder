"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api-client";

type RenameConnectionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  currentName: string;
  onSuccess?: () => void;
};

export function RenameConnectionDialog({
  open,
  onOpenChange,
  connectionId,
  currentName,
  onSuccess,
}: RenameConnectionDialogProps) {
  const [name, setName] = useState(currentName);
  const [saving, setSaving] = useState(false);

  // Reset name when dialog opens with new connection
  const handleOpenChange = (isOpen: boolean) => {
    if (isOpen) {
      setName(currentName);
    }
    onOpenChange(isOpen);
  };

  const handleRename = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Name cannot be empty");
      return;
    }
    if (trimmed === currentName) {
      onOpenChange(false);
      return;
    }

    try {
      setSaving(true);
      await api.appConnection.rename(connectionId, trimmed);
      toast.success("Connection renamed");
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to rename connection"
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename Connection</DialogTitle>
          <DialogDescription>
            Enter a new name for this connection.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="connection-name">Name</Label>
            <Input
              autoFocus
              id="connection-name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleRename();
                }
              }}
              value={name}
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            Cancel
          </Button>
          <Button disabled={saving} onClick={handleRename}>
            {saving ? "Renaming..." : "Rename"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
