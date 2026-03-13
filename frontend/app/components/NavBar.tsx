'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV = [
  { href: '/', label: '🏠 Главная' },
  { href: '/tz', label: '📝 Генератор ТЗ' },
  { href: '/library', label: '📚 Библиотека' },
];

export default function NavBar() {
  const path = usePathname();
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-gray-900/95 backdrop-blur border-b border-gray-800 h-16 flex items-center px-6">
      <span className="text-blue-400 font-bold text-lg mr-8">⚙️ ТЗ Агент</span>
      <div className="flex gap-1">
        {NAV.map(({ href, label }) => {
          const active = href === '/' ? path === '/' : path.startsWith(href);
          return (
            <Link key={href} href={href}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                active
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800'
              }`}>
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
