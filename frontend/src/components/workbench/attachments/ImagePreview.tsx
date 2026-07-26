"use client";

import Image from "next/image";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";

export function ImagePreview({ src, alt, className, sizes = "160px" }: { src: string; alt: string; className?: string; sizes?: string }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button type="button" className={`group relative block overflow-hidden rounded-xl bg-panel text-left ${className || "size-24"}`} title="预览图片" aria-label="预览图片">
          <Image src={src} alt={alt} fill sizes={sizes} className="object-cover transition-transform duration-150 group-hover:scale-[1.02]" unoptimized />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[82dvh] w-[min(860px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-3 shadow-2xl outline-none">
          <Dialog.Title className="sr-only">图片预览</Dialog.Title>
          <div className="relative flex max-h-[76dvh] min-h-24 items-center justify-center overflow-hidden rounded-xl bg-[#f4f4f2]">
            <Image src={src} alt={alt} width={1600} height={1200} sizes="min(860px, calc(100vw - 72px))" className="h-auto max-h-[76dvh] w-auto max-w-full object-contain" unoptimized />
          </div>
          <Dialog.Close asChild>
            <button type="button" className="absolute right-5 top-5 grid size-8 place-items-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/75" title="关闭预览" aria-label="关闭预览"><X className="size-4" /></button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
