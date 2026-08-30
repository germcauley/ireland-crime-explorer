import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const description =
  "Explore official CSO recorded crime by Dublin Garda station geography, or by Garda Division nationwide, offence and trend.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const imageUrl = new URL("/og.png", origin).toString();

  return {
    metadataBase: new URL(origin),
    title: "Ireland Crime Explorer",
    description,
    openGraph: {
      type: "website",
      title: "Ireland Crime Explorer",
      description: "Recorded crime, in context.",
      images: [
        {
          url: imageUrl,
          width: 1200,
          height: 630,
          alt: "Ireland Crime Explorer — recorded crime, in context",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "Ireland Crime Explorer",
      description: "Recorded crime, in context.",
      images: [imageUrl],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Settles the theme before first paint, so a dark-mode reader never
            sees a flash of the light palette. Reads the stored choice first
            and falls back to the system preference. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('theme');" +
              "if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}" +
              "document.documentElement.dataset.theme=t;}catch(e){}})();",
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
