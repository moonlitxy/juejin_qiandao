# 图标文件说明

此文件夹需要包含三个尺寸的图标文件：

## 必需的图标文件

1. **icon16.png** - 16x16 像素
   - 用于浏览器工具栏的小图标
   - 建议使用简单的设计，确保在小尺寸下清晰可辨

2. **icon48.png** - 48x48 像素
   - 用于扩展管理页面
   - 可以包含更多细节

3. **icon128.png** - 128x128 像素
   - 用于Chrome网上应用店
   - 最高分辨率，可以包含完整的设计细节

## 图标设计建议

- 使用掘金相关的元素（如矿工工具、金块、日历等）
- 建议配色：蓝色/紫色系（与插件界面风格一致）
- 确保在不同背景下都清晰可见
- 使用PNG格式，支持透明背景

## 生成图标的方法

### 方法1: 使用在线工具

1. **Favicon Generator**: https://www.favicon-generator.org/
   - 上传一张大图，自动生成多种尺寸

2. **IconKitchen**: https://icon.kitchen/
   - 在线创建和自定义图标

3. **Canva**: https://www.canva.com/
   - 图形设计工具，可以创建自定义图标

### 方法2: 使用设计软件

使用Photoshop、GIMP、Figma等设计软件：
1. 创建128x128像素的设计稿
2. 导出为PNG格式
3. 分别调整为48x48和16x16尺寸

### 方法3: 使用代码生成

如果你有Node.js环境，可以使用以下库生成图标：
```bash
npm install sharp
```

创建一个生成脚本：
```javascript
const sharp = require('sharp');

// 生成不同尺寸的图标
const sizes = [16, 48, 128];

sizes.forEach(size => {
  sharp('source-icon.png') // 使用你的源图标
    .resize(size, size)
    .toFile(`icon${size}.png`)
    .catch(err => console.error(err));
});
```

## 临时解决方案

如果暂时没有图标文件，可以：

1. **复制相同图片**: 使用同一张图片，调整尺寸为三个大小
2. **使用占位图**: 创建简单的纯色方块图标
3. **从网上下载**: 从免费图标网站下载合适的小工具图标

## 检查图标

添加图标后，在浏览器中测试：
1. 重新加载扩展
2. 检查图标是否正确显示
3. 确保不同尺寸下都清晰可见

## 快速创建简单图标

如果你需要快速创建一个临时图标，可以使用以下HTML：

```html
<!DOCTYPE html>
<html>
<head>
    <style>
        .icon {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 60px;
            font-weight: bold;
        }
    </style>
</head>
<body>
    <canvas id="canvas16" width="16" height="16"></canvas>
    <canvas id="canvas48" width="48" height="48"></canvas>
    <canvas id="canvas128" width="128" height="128"></canvas>

    <script>
        ['16', '48', '128'].forEach(size => {
            const canvas = document.getElementById('canvas' + size);
            const ctx = canvas.getContext('2d');

            // 绘制渐变背景
            const gradient = ctx.createLinearGradient(0, 0, size, size);
            gradient.addColorStop(0, '#667eea');
            gradient.addColorStop(1, '#764ba2');
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, size, size);

            // 绘制文字
            ctx.fillStyle = 'white';
            ctx.font = `bold ${size/2}px Arial`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('⛏', size/2, size/2);
        });
    </script>
</body>
</html>
```

将上述HTML保存为文件并在浏览器中打开，然后右键点击canvas元素保存为图片。
