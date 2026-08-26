import React, {useEffect, useState} from 'react'
import {useTheme} from '@/hooks/useTheme'
import './ThemeToggle.scss';

/**
 * 主题切换：Appica <Switch> + 太阳/月亮图标。
 *
 * 语义（与需求对齐）：
 *  - 软件只有「白天」「黑夜」两种模式；
 *  - 默认跟随系统（store 中 mode === 'system'），开关位置与系统一致；
 *  - 用户点击开关即在 白天 / 黑夜 之间手动切换（离开"系统"默认）。
 *
 */

export function ThemeToggle() {
    const {theme, setTheme} = useTheme()

    // 系统暗色偏好（仅 system 模式下使用）
    const [systemPrefersDark, setSystemPrefersDark] = useState(
        () =>
            typeof window !== 'undefined' &&
            window.matchMedia('(prefers-color-scheme: dark)').matches,
    )

    // 系统主题变化时，保持"系统默认"模式下的开关位置与系统一致
    useEffect(() => {
        const mq = window.matchMedia('(prefers-color-scheme: dark)')
        const onChange = () => setSystemPrefersDark(mq.matches)
        mq.addEventListener('change', onChange)
        return () => mq.removeEventListener('change', onChange)
    }, [])


    // 这是全局计算出的真实主题状态
    const globalIsDark = theme === 'system' ? systemPrefersDark : theme === 'dark'

    // 使用一个本地状态来控制开关，初始值等于全局状态
    const [localIsDark, setLocalIsDark] = useState(globalIsDark)

    // 监听全局状态的变化（比如用户在其他地方切换了主题），保持同步
    useEffect(() => {
        setLocalIsDark(globalIsDark)
    }, [globalIsDark])

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const isChecked = e.target.checked

        // 1. 瞬间更新本地状态，解除受控回滚，让开关立刻滑动起来
        setLocalIsDark(isChecked)

        // 2. 核心魔法：延迟触发全局主题更新！
        // 给浏览器让出 150 毫秒的时间，让 GPU 专心把滑动的头几帧渲染出来。
        // 等滑动动画已经在平稳进行了，再去处理繁重的全站 DOM 重绘。
        setTimeout(() => {
            setTheme(isChecked ? 'dark' : 'light')
        }, 150)
    }

    return (
        <label className="theme-custom-switch no-drag-region">
            <input
                type="checkbox"
                checked={localIsDark}
                onChange={handleChange}
            />
            <div className="slider round">
                <div className="sun-moon">
                    <svg className="moon-dot" id="moon-dot-1" viewBox="0 0 100 100">
                        <circle cx={50} cy={50} r={50}/>
                    </svg>
                    <svg className="moon-dot" id="moon-dot-2" viewBox="0 0 100 100">
                        <circle cx={50} cy={50} r={50}/>
                    </svg>
                    <svg className="moon-dot" id="moon-dot-3" viewBox="0 0 100 100">
                        <circle cx={50} cy={50} r={50}/>
                    </svg>

                    <svg className="light-ray" id="light-ray-1" viewBox="0 0 100 100">
                        <circle cx={50} cy={50} r={50}/>
                    </svg>
                    <svg className="light-ray" id="light-ray-2" viewBox="0 0 100 100">
                        <circle cx={50} cy={50} r={50}/>
                    </svg>
                    <svg className="light-ray" id="light-ray-3" viewBox="0 0 100 100">
                        <circle cx={50} cy={50} r={50}/>
                    </svg>

                    <svg className="cloud-dark" id="cloud-1" viewBox="0 0 100 100">
                        <circle cx={50} cy={50} r={50}/>
                    </svg>
                    <svg className="cloud-dark" id="cloud-2" viewBox="0 0 100 100">
                        <circle cx={50} cy={50} r={50}/>
                    </svg>
                    <svg className="cloud-dark" id="cloud-3" viewBox="0 0 100 100">
                        <circle cx={50} cy={50} r={50}/>
                    </svg>

                    <svg className="cloud-light" id="cloud-4" viewBox="0 0 100 100">
                        <circle cx={50} cy={50} r={50}/>
                    </svg>
                    <svg className="cloud-light" id="cloud-5" viewBox="0 0 100 100">
                        <circle cx={50} cy={50} r={50}/>
                    </svg>
                    <svg className="cloud-light" id="cloud-6" viewBox="0 0 100 100">
                        <circle cx={50} cy={50} r={50}/>
                    </svg>
                </div>
                <div className="stars">
                    <svg className="star" id="star-1" viewBox="0 0 20 20">
                        <path
                            d="M 0 10 C 10 10,10 10 ,0 10 C 10 10 , 10 10 , 10 20 C 10 10 , 10 10 , 20 10 C 10 10 , 10 10 , 10 0 C 10 10,10 10 ,0 10 Z"/>
                    </svg>
                    <svg className="star" id="star-2" viewBox="0 0 20 20">
                        <path
                            d="M 0 10 C 10 10,10 10 ,0 10 C 10 10 , 10 10 , 10 20 C 10 10 , 10 10 , 20 10 C 10 10 , 10 10 , 10 0 C 10 10,10 10 ,0 10 Z"/>
                    </svg>
                    <svg className="star" id="star-3" viewBox="0 0 20 20">
                        <path
                            d="M 0 10 C 10 10,10 10 ,0 10 C 10 10 , 10 10 , 10 20 C 10 10 , 10 10 , 20 10 C 10 10 , 10 10 , 10 0 C 10 10,10 10 ,0 10 Z"/>
                    </svg>
                    <svg className="star" id="star-4" viewBox="0 0 20 20">
                        <path
                            d="M 0 10 C 10 10,10 10 ,0 10 C 10 10 , 10 10 , 10 20 C 10 10 , 10 10 , 20 10 C 10 10 , 10 10 , 10 0 C 10 10,10 10 ,0 10 Z"/>
                    </svg>
                </div>
            </div>
        </label>
    );
}
