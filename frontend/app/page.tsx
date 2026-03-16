import Link from 'next/link';

const cards = [
  {
    href: '/tz',
    icon: '📝',
    title: 'Генератор ТЗ',
    desc: 'Создайте техническое задание на основе описания объекта и библиотеки документов',
    color: 'from-blue-900/40 to-blue-800/20 border-blue-800 hover:border-blue-600',
  },
  {
    href: '/library',
    icon: '📚',
    title: 'Библиотека',
    desc: 'Загружайте ГОСТы, СНИПы, аналоги ТЗ — агент использует их при генерации',
    color: 'from-purple-900/40 to-purple-800/20 border-purple-800 hover:border-purple-600',
  },
  {
    href: '/workshop',
    icon: '🛠️',
    title: 'Мастерская ТЗ',
    desc: 'Сохранённые ТЗ: проверка, уточняющие вопросы и повторная доработка',
    color: 'from-orange-900/40 to-orange-800/20 border-orange-800 hover:border-orange-600',
  },
];

export default function HomePage() {
  return (
    <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center p-8">
      <div className="max-w-3xl w-full space-y-8 text-center">
        <div>
          <h1 className="text-5xl font-bold mb-3">⚙️ ТЗ Агент</h1>
          <p className="text-gray-400 text-lg">Автоматическая генерация технических заданий с помощью AI</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {cards.map(c => (
            <Link key={c.href} href={c.href}
              className={`bg-gradient-to-br ${c.color} border rounded-2xl p-6 text-left transition group`}>
              <p className="text-4xl mb-3">{c.icon}</p>
              <h2 className="text-xl font-semibold mb-1 group-hover:text-white transition">{c.title}</h2>
              <p className="text-gray-400 text-sm leading-relaxed">{c.desc}</p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
