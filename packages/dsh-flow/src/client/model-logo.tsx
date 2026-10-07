import { IconSparkleRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import deepseek from '@lobehub/icons-static-svg/icons/deepseek.svg';
import openai from '@lobehub/icons-static-svg/icons/openai.svg';
import claude from '@lobehub/icons-static-svg/icons/claude.svg';
import gemini from '@lobehub/icons-static-svg/icons/gemini.svg';
import qwen from '@lobehub/icons-static-svg/icons/qwen.svg';
import meta from '@lobehub/icons-static-svg/icons/meta.svg';
import mistral from '@lobehub/icons-static-svg/icons/mistral.svg';
import grok from '@lobehub/icons-static-svg/icons/grok.svg';
import kimi from '@lobehub/icons-static-svg/icons/kimi.svg';
import zhipu from '@lobehub/icons-static-svg/icons/zhipu.svg';
import { modelBrand } from '../identity.ts';
const LOGOS={DeepSeek:deepseek,OpenAI:openai,Anthropic:claude,Google:gemini,Alibaba:qwen,Meta:meta,Mistral:mistral,xAI:grok,Moonshot:kimi,Zhipu:zhipu};
export function ModelLogo({model}:{model:string}) {
  const brand=modelBrand(model),logo=brand==='unknown'?null:LOGOS[brand];
  // esbuild preserves quotes inside SVG data URLs; escape them for CSS URLs.
  const mask=logo?`url("${logo.replaceAll('"','%22').replaceAll("'",'%27')}")`:undefined;
  return logo?<span className="flow-model-logo" role="img" aria-label={brand} title={brand} style={{maskImage:mask,WebkitMaskImage:mask}}/>:<IconSparkleRegular size={13} className="flow-model-fallback" aria-label="模型"/>;
}
