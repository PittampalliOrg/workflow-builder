"use client";

import type { ReactNode } from "react";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";

type RunDetailSheetProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description?: string;
	children: ReactNode;
};

export function RunDetailSheet({
	open,
	onOpenChange,
	title,
	description,
	children,
}: RunDetailSheetProps) {
	return (
		<Sheet onOpenChange={onOpenChange} open={open}>
			<SheetContent className="w-full gap-0 p-0 sm:max-w-3xl" side="right">
				<SheetHeader className="border-b p-3">
					<SheetTitle>{title}</SheetTitle>
					{description ? (
						<SheetDescription>{description}</SheetDescription>
					) : null}
				</SheetHeader>
				<div className="h-full overflow-auto p-3">{children}</div>
			</SheetContent>
		</Sheet>
	);
}
