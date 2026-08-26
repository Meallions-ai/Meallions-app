import "./globals.css";
import PwaRegister from "./PwaRegister";

export const metadata = {
  title: "MEALLIONS 도시락",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "MEALLIONS",
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#4F7A44",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <PwaRegister />
        {children}
      </body>
    </html>
  );
}