import { RouterProvider } from 'react-router-dom'
import { router } from '@/core/router'

export default function App() {
  return <RouterProvider router={router} />
}
