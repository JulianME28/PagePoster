<?php
namespace PagePoster\Bridge;

final class Fault extends \RuntimeException {
    public string $slug;
    public int $httpStatus;
    public function __construct(string $slug, string $message, int $httpStatus) {
        parent::__construct($message);
        $this->slug = $slug;
        $this->httpStatus = $httpStatus;
    }
}

final class Contract {
    public const VERSION = '0.2.1';
    public const MAX_CONTENT_BYTES = 1000000;

    public static function operationId($value): string {
        if (!is_string($value) || !preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/D', $value)) {
            throw new Fault('pp_bridge_validation', 'operationId must be a lowercase UUID.', 400);
        }
        return $value;
    }
    private static function validText($value, int $limit, bool $required = false): bool {
        return is_string($value) && strlen($value) <= $limit && strpos($value, "\0") === false &&
            preg_match('//u', $value) === 1 && (!$required || trim($value) !== '');
    }
    public static function marked(string $content): bool {
        if (!class_exists('\DOMDocument')) throw new Fault('pp_bridge_dom_required', 'The PHP DOM extension is required.', 503);
        $document = new \DOMDocument();
        if (!$document->loadHTML('<?xml encoding="UTF-8">' . $content, LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING)) return false;
        $matches = (new \DOMXPath($document))->query('//*[@id="pp-landing" or @id="pp-universal-pl"]');
        return $matches !== false && $matches->length === 1 &&
            strtolower($matches->item(0)->nodeName) === 'div';
    }
    public static function validate($input): array {
        if (!is_array($input) || !isset($input['kind']) || !in_array($input['kind'], ['create', 'update', 'adopt'], true)) {
            throw new Fault('pp_bridge_validation', 'A create, update or adopt operation is required.', 400);
        }
        $fields = $input['kind'] === 'adopt' ? ['operationId', 'kind', 'postType', 'postId', 'expectedContentHash'] : ['operationId', 'kind', 'postType', 'title', 'content', 'status'];
        if ($input['kind'] === 'update') $fields = array_merge($fields, ['postId', 'expectedContentHash']);
        if (array_diff(array_keys($input), $fields) || array_diff($fields, array_keys($input))) {
            throw new Fault('pp_bridge_validation', 'The operation contains missing or unsupported fields.', 400);
        }
        self::operationId($input['operationId']);
        if ($input['kind'] !== 'adopt' && (!in_array($input['postType'], ['page', 'post'], true) ||
            !in_array($input['status'], ['draft', 'publish'], true) ||
            !self::validText($input['title'], 2000, true) ||
            !self::validText($input['content'], self::MAX_CONTENT_BYTES, true) ||
            !self::marked($input['content']))) {
            throw new Fault('pp_bridge_validation', 'Only marked PagePoster page/post content and draft/publish states are accepted.', 400);
        }
        if (in_array($input['kind'], ['update','adopt'], true) &&
            (!in_array($input['postType'], ['page','post'], true) || !is_int($input['postId']) || $input['postId'] < 1 ||
             !is_string($input['expectedContentHash']) || !preg_match('/^[a-f0-9]{64}$/D', $input['expectedContentHash']))) {
            throw new Fault('pp_bridge_validation', 'Updates require a positive postId and exact expectedContentHash.', 400);
        }
        $result = [];
        foreach ($fields as $field) $result[$field] = $input[$field];
        return $result;
    }
    public static function contentHash(array $post): string {
        $bytes = "pageposter-snapshot-v1\0";
        foreach (['post_type', 'post_title', 'post_content', 'post_status'] as $field) {
            $value = (string) $post[$field];
            $bytes .= strlen($value) . ':' . $value;
        }
        return hash('sha256', $bytes);
    }
    public static function payloadHash(array $input): string {
        return hash('sha256', json_encode(self::validate($input), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
    }
}
