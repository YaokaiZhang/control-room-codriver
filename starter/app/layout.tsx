import type { Metadata, Viewport } from "next"
import { Archivo, Figtree } from "next/font/google"
import { currentPersona } from "@/lib/persona-server"
import { PersonaProvider } from "./components/persona"
import "./globals.css"

// Open stand-ins for Bahn's licensed faces, self-hosted by Next: Archivo with its width axis for Owners Wide, Figtree for Duplet Open.
const archivo = Archivo({ subsets: ["latin", "latin-ext"], axes: ["wdth"], variable: "--font-archivo", display: "swap" })
const figtree = Figtree({ subsets: ["latin", "latin-ext"], variable: "--font-figtree", display: "swap" })

export const metadata: Metadata = {
  title: "Co-Driver · Bahn",
  description: "Where Bahn operators and agents work together to get every car delivered. Fictional data.",
}

export const viewport: Viewport = { themeColor: "#fffef7", width: "device-width", initialScale: 1 }

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const persona = await currentPersona()
  return (
    <html lang="en" className={`${archivo.variable} ${figtree.variable}`}>
      <body><PersonaProvider persona={persona}>{children}</PersonaProvider></body>
    </html>
  )
}
